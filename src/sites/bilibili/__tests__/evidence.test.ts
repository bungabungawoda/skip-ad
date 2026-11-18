import { describe, expect, it } from "vitest";
import { buildEvidencePack } from "../analysis/evidence";
import type { SignalSet } from "../analysis/signals";
import type { DanmakuItem } from "../types";
import type { SubtitleCue } from "../../../core/plugin/types";

function emptySignals(): SignalSet {
  return {
    jumpTargets: [],
    adWordHits: [],
    divergentTerms: [],
    ctaHits: [],
    chapterHits: [],
    novelty: [],
    repeat: [],
    densitySpikes: [],
    boundaries: []
  };
}

function cues(count: number, chars: number): SubtitleCue[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * 0.5,
    end: index * 0.5 + 0.4,
    text: "字".repeat(chars)
  }));
}

function danmaku(count: number): DanmakuItem[] {
  return Array.from({ length: count }, (_, index) => ({
    time: index * 0.1,
    mode: 1,
    // 每条文本都不一样，避免被同窗口去重合并。
    text: index % 2 === 0 ? `广告${index}` : `普通弹幕${index}`
  }));
}

describe("buildEvidencePack", () => {
  it("clips cues to the chunk and caps their characters", () => {
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: cues(200, 100),
      danmaku: danmaku(500),
      signals: emptySignals(),
      candidates: [{ start: 20, end: 30, score: 0.5, arms: ["ad_word"], parts: { jump: 0, adWord: 1, chapter: 0, divergent: 0, transcript: 0 } }]
    });
    // 预算 6000 字符、每条 100 字符：恰好保留 60 条，不是「少于 100」这类恒真上界。
    expect(pack.cues).toHaveLength(60);
    expect(pack.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBe(6000);
    // 分块 [0,60] 之外的台词不进证据包。
    expect(pack.cues.some((cue) => cue.start >= 60)).toBe(false);
  });

  it("同起点的多句台词都保留，不被起点键吞掉", () => {
    const shared: SubtitleCue[] = [
      { start: 1, end: 2, text: "甲".repeat(3000) },
      { start: 1, end: 2.5, text: "乙".repeat(3000) },
      { start: 3, end: 4, text: "丙".repeat(3000) }
    ];
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: shared,
      danmaku: [],
      signals: emptySignals(),
      candidates: []
    });
    // 预算 6000：甲、乙各 3000 都保留，丙超预算被裁。
    expect(pack.cues.map((cue) => cue.text[0])).toEqual(["甲", "乙"]);
    expect(pack.coverage.cueCharsShown).toBe(6000);
  });

  it("单条台词超过字符预算时也要发出去，不能把整块台词裁空", () => {
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: [{ start: 1, end: 2, text: "字".repeat(7000) }],
      danmaku: [],
      signals: emptySignals(),
      candidates: []
    });
    expect(pack.cues).toHaveLength(1);
    expect(pack.coverage.cueCharsShown).toBe(7000);
  });

  it("does not truncate when the input is small", () => {
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "danmaku",
      cues: [],
      danmaku: danmaku(10),
      signals: emptySignals(),
      candidates: []
    });
    expect(pack.cues).toEqual([]);
    expect(pack.danmaku).toHaveLength(10);
  });

  it("keeps ad-word danmaku first when the budget is tight", () => {
    const items: DanmakuItem[] = Array.from({ length: 600 }, (_, index) => ({
      time: index * 0.1,
      mode: 1,
      // 每条文本都不一样，避免被同窗口去重合并。
      text: index % 5 === 0 ? `广告${index}` : `普通弹幕${index}`
    }));
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: [],
      danmaku: items,
      signals: emptySignals(),
      candidates: []
    });
    expect(pack.danmaku).toHaveLength(400);
    // 含广告词的弹幕优先，最多占 120 个名额。
    expect(pack.danmaku.filter((item) => item.text.startsWith("广告"))).toHaveLength(120);
  });

  it("同一窗口同一文本超过 3 次只留 1 条，并标出现次数", () => {
    const spam: DanmakuItem[] = Array.from({ length: 20 }, (_, index) => ({
      time: 1 + index * 0.1,
      mode: 1,
      text: "你被骗了"
    }));
    const few: DanmakuItem[] = Array.from({ length: 3 }, (_, index) => ({
      time: 8 + index * 0.1,
      mode: 1,
      text: "草"
    }));
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: [],
      danmaku: [...spam, ...few, { time: 2, mode: 1, text: "这段好听" }],
      signals: emptySignals(),
      candidates: []
    });
    const repeated = pack.danmaku.filter((item) => item.text === "你被骗了");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.count).toBe(20);
    // 没超过 3 次的原样保留，不带次数。
    expect(pack.danmaku.filter((item) => item.text === "草")).toHaveLength(3);
    expect(pack.danmaku.filter((item) => item.text === "草").every((item) => !item.count)).toBe(
      true
    );
  });

  it("keeps cues near a candidate even when the character budget is exhausted", () => {
    const far: SubtitleCue[] = Array.from({ length: 130 }, (_, index) => ({
      start: 100 + index,
      end: 100 + index + 0.5,
      text: "字".repeat(50)
    }));
    const near: SubtitleCue = { start: 25, end: 26, text: "候选附近" };
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 200 },
      mode: "full",
      cues: [...far, near],
      danmaku: [],
      signals: emptySignals(),
      candidates: [{ start: 24, end: 30, score: 1, arms: ["ad_word"], parts: { jump: 0, adWord: 1, chapter: 0, divergent: 0, transcript: 0 } }]
    });
    expect(pack.cues.some((cue) => cue.text === "候选附近")).toBe(true);
    expect(pack.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(6000);
  });
});

describe("弹幕裁剪的优先级", () => {
  it("名额不够时先保出现次数高的弹幕", () => {
    const unique: DanmakuItem[] = Array.from({ length: 500 }, (_, index) => ({
      time: index * 0.1,
      mode: 1,
      text: `普通弹幕${index}`
    }));
    const repeated: DanmakuItem[] = [60, 40, 20].map((count, index) => ({
      time: 10 + index,
      mode: 1,
      text: `刷屏${index}`,
      count
    }));
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "danmaku",
      cues: [],
      danmaku: [...unique, ...repeated],
      signals: emptySignals(),
      candidates: []
    });
    expect(pack.danmaku).toHaveLength(400);
    // 三条重复弹幕都在，且次数原样保留。
    for (const item of repeated) {
      const kept = pack.danmaku.find((entry) => entry.text === item.text);
      expect(kept?.count).toBe(item.count);
    }
  });
});

describe("证据覆盖与台词提示", () => {
  it("覆盖范围写清裁剪前后的数量", () => {
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 0, start: 0, end: 60 },
      mode: "full",
      cues: cues(100, 100),
      danmaku: danmaku(500),
      signals: emptySignals(),
      candidates: []
    });
    expect(pack.coverage.danmakuTotal).toBe(500);
    expect(pack.coverage.danmakuShown).toBe(400);
    expect(pack.coverage.cueCharsTotal).toBe(10_000);
    expect(pack.coverage.cueCharsShown).toBeLessThanOrEqual(6000);
  });

  it("给坐标和边界附上目标附近的台词", () => {
    const signalSet = emptySignals();
    signalSet.jumpTargets = [
      {
        time: 120,
        votes: 3,
        firstPosition: 10,
        lastPosition: 20,
        modePosition: { start: 18, end: 21, votes: 2 }
      }
    ];
    signalSet.boundaries = [
      { time: 150, direction: "content", phrase: "正片开始", count: 3, first: 149, last: 151 }
    ];
    const pack = buildEvidencePack({
      duration: 600,
      chunk: { index: 1, start: 100, end: 200 },
      mode: "full",
      cues: [
        { start: 121, end: 123, text: "好，那回到正题" },
        { start: 151, end: 153, text: "我们继续" }
      ],
      danmaku: [],
      signals: signalSet,
      candidates: []
    });
    expect(pack.jumpTargets[0]?.cueHint).toEqual({ start: 121, text: "好，那回到正题" });
    expect(pack.boundaries[0]?.cueHint).toEqual({ start: 151, text: "我们继续" });
  });
});

describe("附近台词查找", () => {
  /** 朴素实现：与改造前的线性扫描逐字一致，用来证明二分版没有改变语义。 */
  function naive(cues: SubtitleCue[], time: number) {
    const containing = cues.find((cue) => cue.start <= time && time <= cue.end);
    if (containing) return { start: containing.start, text: containing.text };
    const next = cues.find((cue) => cue.start > time && cue.start - time <= 6);
    if (next) return { start: next.start, text: next.text };
    for (let index = cues.length - 1; index >= 0; index -= 1) {
      const cue = cues[index];
      if (cue && cue.end < time && time - cue.end <= 3) {
        return { start: cue.start, text: cue.text };
      }
    }
    return undefined;
  }

  function packFor(cues: SubtitleCue[], times: number[]) {
    const signals = emptySignals();
    signals.jumpTargets = times.map((time) => ({ time, votes: 3 }));
    return buildEvidencePack({
      duration: 10_000,
      chunk: { index: 0, start: 0, end: 10_000 },
      mode: "full",
      cues,
      danmaku: [],
      signals,
      candidates: []
    });
  }

  it("与线性扫描在随机台词与随机时间上结果一致", () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let round = 0; round < 20; round += 1) {
      const raw: SubtitleCue[] = Array.from({ length: 40 }, () => {
        const start = Math.round(rand() * 1000) / 10;
        return { start, end: start + Math.round(rand() * 40) / 10, text: `台词${start}` };
      });
      // 允许同一秒多条（真实字幕会出现），但保持起点升序。
      const sorted = [...raw].sort((a, b) => a.start - b.start);
      const times = Array.from({ length: 60 }, () => Math.round(rand() * 1100) / 10);
      const pack = packFor(sorted, times);
      pack.jumpTargets.forEach((target, index) => {
        expect(target.cueHint).toEqual(naive(sorted, times[index] as number));
      });
    }
  });

  it("无序台词退回线性扫描，结果同样一致", () => {
    const unsorted: SubtitleCue[] = [
      { start: 30, end: 32, text: "后" },
      { start: 10, end: 20, text: "前" },
      { start: 12, end: 13, text: "重叠" }
    ];
    const times = [5, 11, 12.5, 19, 21, 25, 31, 33];
    const pack = packFor(unsorted, times);
    pack.jumpTargets.forEach((target, index) => {
      expect(target.cueHint).toEqual(naive(unsorted, times[index] as number));
    });
  });
});
