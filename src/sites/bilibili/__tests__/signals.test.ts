import { describe, expect, it } from "vitest";
import { buildSignals } from "../analysis/signals";
import type { DanmakuItem } from "../types";
import type { SubtitleCue } from "../../../core/plugin/types";
import type { SignalSet } from "../analysis/signals";

function danmaku(time: number, text: string): DanmakuItem {
  return { time, mode: 1, text };
}

function cue(start: number, text: string): SubtitleCue {
  return { start, end: start + 2, text };
}

function signals(input: {
  title?: string;
  description?: string;
  duration?: number;
  cues?: SubtitleCue[];
  danmaku?: DanmakuItem[];
  chapters?: Array<{ start: number; end: number; title: string }>;
}): SignalSet {
  return buildSignals({
    title: input.title ?? "测试视频",
    description: input.description ?? "",
    duration: input.duration ?? 300,
    cues: input.cues ?? [],
    danmaku: input.danmaku ?? [],
    chapters: input.chapters ?? []
  });
}

describe("local signals", () => {
  it("counts jump coordinates and ignores nearby same-time posts", () => {
    const targets = signals({
      danmaku: [
        danmaku(5, "空降 01:00"),
        danmaku(6, "01:00 空降"),
        danmaku(7, "空降1:00"),
        danmaku(60, "01:00 就在这"),
        danmaku(120, "空降 02:00"),
        danmaku(121, "空降 03:00")
      ]
    }).jumpTargets;
    expect(targets[0]).toMatchObject({ time: 60, votes: 3 });
  });

  it("finds ad words, CTA phrases, and chapter hints", () => {
    const withAdWords = signals({
      danmaku: [danmaku(10, "这里广告"), danmaku(20, "恰饭")]
    });
    expect(withAdWords.adWordHits).toHaveLength(2);
    const withCta = signals({
      cues: [cue(10, "点击简介链接领券"), cue(30, "继续看剧情")]
    });
    expect(withCta.ctaHits[0]?.phrase).toBe("链接");
    const withChapter = signals({
      chapters: [
        { start: 0, end: 100, title: "品牌合作情报" },
        { start: 100, end: 200, title: "正片" }
      ]
    });
    expect(withChapter.chapterHits).toHaveLength(1);
  });

  it("finds viewer terms that the transcript never uses", () => {
    const terms = signals({
      cues: [cue(0, "今天聊聊这个游戏"), cue(10, "玩法很有意思"), cue(20, "继续看下去")],
      danmaku: [
        danmaku(100, "恰饭"),
        danmaku(110, "恰饭"),
        danmaku(120, "恰饭"),
        danmaku(130, "这是恰饭"),
        danmaku(200, "无关")
      ]
    }).divergentTerms;
    expect(terms.some((term) => term.term.includes("恰饭"))).toBe(true);
    expect(terms.every((term) => term.count >= 3)).toBe(true);
  });

  it("finds novelty and repeated terms inside a block", () => {
    const cues = [
      cue(0, "本期视频由赞助商提供"),
      cue(10, "赞助商提供福利"),
      cue(20, "点击简介领取福利"),
      cue(100, "我们继续讲剧情")
    ];
    const result = signals({ cues, title: "剧情视频", duration: 200 });
    expect(result.novelty.length).toBeGreaterThan(0);
    expect(result.repeat.some((block) => block.terms.some((term) => term.includes("赞助商")))).toBe(
      true
    );
  });

  it("extracts grams and ignores spread-out or out-of-range targets", () => {
    const result = signals({
      cues: [cue(0, "赞助商提供")],
      danmaku: [
        danmaku(0, "空降 99:00"),
        danmaku(0, "空降 00:01"),
        danmaku(100, "恰饭"),
        danmaku(200, "恰饭")
      ]
    });
    expect(result.jumpTargets).toEqual([]);
    expect(result.divergentTerms).toEqual([]);
  });

  it("recognizes three-digit minutes and h:mm:ss coordinates", () => {
    // 120:00 是 7200 秒，不是 20:00；1:05:30 是 3930 秒，不是 65 秒。
    const long = signals({
      duration: 9000,
      danmaku: [danmaku(100, "空降 120:00"), danmaku(101, "空降 120:00")]
    }).jumpTargets;
    expect(long[0]?.time).toBe(7200);
    const hours = signals({
      duration: 9000,
      danmaku: [danmaku(10, "空降 1:05:30"), danmaku(11, "空降 1:05:30")]
    }).jumpTargets;
    expect(hours[0]?.time).toBe(3930);
  });

  it("drops terms that are substrings of a stronger term", () => {
    const terms = signals({
      danmaku: [
        danmaku(100, "恰饭"),
        danmaku(101, "恰饭了"),
        danmaku(102, "恰饭"),
        danmaku(103, "恰饭了"),
        danmaku(104, "恰饭"),
        danmaku(105, "恰饭了")
      ]
    }).divergentTerms;
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.filter((term) => term.term.includes("恰饭"))).toHaveLength(1);
  });

  it("excludes terms that already appear in the transcript", () => {
    expect(
      signals({
        cues: [cue(0, "这是恰饭"), cue(10, "恰饭内容"), cue(20, "恰饭结束")],
        danmaku: [danmaku(100, "恰饭"), danmaku(101, "恰饭"), danmaku(102, "恰饭")]
      }).divergentTerms
    ).toEqual([]);
  });

  it("returns no novelty for empty input", () => {
    expect(signals({ duration: 0 }).novelty).toEqual([]);
    expect(signals({ duration: 0 }).repeat).toEqual([]);
  });

  it("combines all signals", () => {
    const signals = buildSignals({
      title: "测试视频",
      description: "本期由赞助商提供",
      duration: 300,
      cues: [cue(10, "点击简介链接"), cue(20, "广告时间"), cue(30, "继续")],
      danmaku: [danmaku(60, "空降 01:00"), danmaku(61, "空降 01:00"), danmaku(70, "广告")],
      chapters: [{ start: 0, end: 60, title: "广告" }]
    });
    expect(signals.adWordHits.length).toBeGreaterThan(0);
    expect(signals.ctaHits.length).toBeGreaterThan(0);
    expect(signals.chapterHits).toHaveLength(1);
  });
});

describe("弹幕密度窗口合并", () => {
  it("密集弹幕给出一段覆盖密集时间的窗口", () => {
    const merged = signals({
      duration: 60,
      danmaku: [
        ...Array.from({ length: 20 }, (_, index) => danmaku(10 + index * 0.5, "广告"))
      ]
    }).densitySpikes;
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ start: 5, end: 25, count: 20 });
  });

  it("稀疏或空输入没有密度窗口", () => {
    const merged = signals({
      duration: 60,
      danmaku: [danmaku(10, "广告"), danmaku(20, "广告")]
    }).densitySpikes;
    expect(merged).toEqual([]);
    expect(signals({ duration: 0 }).densitySpikes).toEqual([]);
  });
});

describe("坐标合并与边界句", () => {
  it("把 3 秒内的相邻目标合成一票，并保留弹幕位置范围", () => {
    const targets = signals({
      duration: 2400,
      danmaku: [danmaku(5, "指路31：57"), danmaku(6, "part在31:58"), danmaku(7, "空降31:59")]
    }).jumpTargets;
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      time: 1918,
      votes: 3,
      firstPosition: 5,
      lastPosition: 7,
      // 弹幕位置 5/6/7 按 3 秒分桶：桶 [6,9) 有 2 票，是高频桶。
      modePosition: { start: 6, end: 9, votes: 2 }
    });
    expect(targets[0]?.phrases?.length).toBeGreaterThan(0);
  });

  it("丢弃回头指路的坐标", () => {
    const targets = signals({
      duration: 4000,
      danmaku: [danmaku(3886, "6:51的宝宝赞我"), danmaku(10, "空降 01:00")]
    }).jumpTargets;
    expect(targets.map((target) => target.time)).toEqual([60]);
  });

  it("同一方向的边界句聚成一簇", () => {
    const hits = signals({
      danmaku: [
      danmaku(1909, "正片开始"),
      danmaku(1914, "正片开始，一番妈来了！"),
      danmaku(1917, "空降成功"),
      danmaku(1925, "正片开始"),
      danmaku(100, "广告开始")
      ]
    }).boundaries;
    const content = hits.find((hit) => hit.direction === "content");
    expect(content).toMatchObject({ phrase: "正片开始", count: 4, first: 1909, last: 1925 });
    expect(hits.find((hit) => hit.direction === "ad")).toMatchObject({
      phrase: "广告开始",
      count: 1
    });
  });

  it("同时命中两个边界词时取更长的那个", () => {
    const longer = signals({ danmaku: [danmaku(10, "正片开始了")] }).boundaries;
    expect(longer[0]?.phrase).toBe("正片开始了");
    // 「广告时间到」是内容恢复，不能被短词「广告时间」判成广告侧。
    const ended = signals({ danmaku: [danmaku(20, "广告时间到")] }).boundaries;
    expect(ended[0]).toMatchObject({ phrase: "广告时间到", direction: "content" });
  });
});
