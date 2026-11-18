import { describe, expect, it } from "vitest";
import { buildConversationSystemPrompt, buildRoundUserMessage } from "../analysis/prompt";
import type { EvidencePack } from "../analysis/evidence";
import type { DanmakuItem } from "../types";

function makePack(danmaku: DanmakuItem[], overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    duration: 600,
    chunk: { index: 0, start: 0, end: 300 },
    mode: "full",
    subtitleEnd: 0,
    candidates: [],
    cues: [],
    danmaku,
    jumpTargets: [],
    boundaries: [],
    adWordHits: [],
    divergentTerms: [],
    ctaHits: [],
    coverage: {
      danmakuTotal: danmaku.length,
      danmakuShown: danmaku.length,
      cueCharsTotal: 0,
      cueCharsShown: 0
    },
    ...overrides
  };
}

function userContent(danmaku: DanmakuItem[]): string {
  // 生产链路就是 analyzer 每轮发的用户消息；系统消息由 createConversation 单独构造。
  return buildRoundUserMessage(makePack(danmaku)).content;
}

describe("弹幕 5 秒分桶", () => {
  it("同一 5 秒桶内的弹幕合并成一行，时间头只出现一次", () => {
    const content = userContent([
      { time: 100.2, mode: 1, text: "广告" },
      { time: 101, mode: 1, text: "恰饭" },
      { time: 104, mode: 1, text: "又是广告" }
    ]);
    expect(content).toContain("[01:40-01:45] 广告｜恰饭｜又是广告");
    expect(content.match(/\[01:40/g)).toHaveLength(1);
  });

  it("相隔 5 秒以上的弹幕进入不同桶", () => {
    const content = userContent([
      { time: 100, mode: 1, text: "广告" },
      { time: 105, mode: 1, text: "恰饭" }
    ]);
    expect(content).toContain("[01:40-01:45] 广告");
    expect(content).toContain("[01:45-01:50] 恰饭");
  });

  it("桶内弹幕按出现时间排序", () => {
    const content = userContent([
      { time: 103, mode: 1, text: "后发的" },
      { time: 101, mode: 1, text: "先发的" }
    ]);
    expect(content).toContain("[01:40-01:45] 先发的｜后发的");
  });

  it("无弹幕时保留占位文案", () => {
    const content = userContent([]);
    expect(content).toContain("===== [4] 弹幕样本（裁剪后） =====\n（无弹幕）");
  });
});

describe("字幕只覆盖前半段时的提示", () => {
  it("把台词结束时间和全片时长都告诉模型", () => {
    const pack = makePack([], { subtitleEnd: 60.2, duration: 77 });
    const content = buildRoundUserMessage(pack).content;
    expect(content).toContain("全片台词只到 01:00 (60.2s)");
    expect(content).toContain("视频总时长：01:17 (77.0s)");
    expect(content).toContain("之后没有台词");
  });

  it("字幕覆盖到结尾时不加这句", () => {
    const pack = makePack([], { subtitleEnd: 598, duration: 600 });
    const content = buildRoundUserMessage(pack).content;
    expect(content).not.toContain("台词只到");
  });
});

describe("重复弹幕的次数标记", () => {
  it("合并后的弹幕在提示词里带上出现次数", () => {
    const content = userContent([{ time: 1, mode: 1, text: "你被骗了", count: 20 }]);
    expect(content).toContain("你被骗了 ×20");
  });

  it("普通弹幕不带次数", () => {
    const content = userContent([{ time: 1, mode: 1, text: "这段好听" }]);
    expect(content).toContain("这段好听");
    expect(content).not.toContain("×");
  });
});

describe("给模型的分维证据", () => {
  it("每个维度都有显式分隔块，顺序固定", () => {
    const lines = userContent([])
      .split("\n")
      .filter((line) => line.startsWith("===== ["));
    expect(lines).toHaveLength(10);
    for (const [index, title] of [
      "覆盖范围",
      "候选窗口",
      "台词",
      "弹幕样本",
      "空降坐标",
      "内容边界",
      "广告词命中",
      "观众独有词",
      "行动号召",
      "输出要求"
    ].entries()) {
      expect(lines[index]).toContain(title);
    }
  });

  it("坐标票带弹幕位置范围、说法和 B 处台词", () => {
    const pack = makePack([], {
      jumpTargets: [
        {
          time: 200,
          votes: 12,
          firstPosition: 45,
          lastPosition: 190,
          modePosition: { start: 45, end: 48, votes: 6 },
          targetMin: 198,
          targetMax: 202,
          phrases: ["空降3:20", "指路3:20"],
          cueHint: { start: 122, text: "好，那回到正题" }
        }
      ]
    });
    const content = buildRoundUserMessage(pack).content;
    expect(content).toContain("03:20 12 票");
    expect(content).toContain("（目标 03:18–03:22）");
    expect(content).toContain("弹幕位置 00:45–03:10（高频 00:45–00:48 ×6）");
    expect(content).toContain("说法：「空降3:20」 「指路3:20」");
    expect(content).toContain("B 处台词 @02:02：好，那回到正题");
  });

  it("边界句带方向和时间范围", () => {
    const pack = makePack([], {
      boundaries: [
        { time: 1917, direction: "content", phrase: "正片开始", count: 16, first: 1909, last: 1925 }
      ]
    });
    const content = buildRoundUserMessage(pack).content;
    expect(content).toContain("[31:57] 正片开始 ×16（31:49–32:05） → 内容恢复");
  });

  it("候选窗口给组成项，不给 score", () => {
    const pack = makePack([], {
      candidates: [
        {
          start: 180,
          end: 220,
          score: 1.05,
          arms: ["jump_coordinate", "ad_word"],
          parts: { jump: 5, adWord: 3, chapter: 1, divergent: 0, transcript: 0 }
        }
      ]
    });
    const content = buildRoundUserMessage(pack).content;
    expect(content).toContain("[03:00-03:40] 空降票 5 · 广告词 3 · 章节 1");
    expect(content).not.toContain("score=");
  });

  it("覆盖范围写清裁剪前后的数量", () => {
    const pack = makePack([], {
      coverage: {
        danmakuTotal: 1200,
        danmakuShown: 400,
        cueCharsTotal: 8200,
        cueCharsShown: 6000
      }
    });
    const content = buildRoundUserMessage(pack).content;
    expect(content).toContain("弹幕 400/1200 条");
    expect(content).toContain("台词 6000/8200 字");
  });

  it("系统提示带证据读法", () => {
    const system = buildConversationSystemPrompt().content;
    expect(system).toContain("===== 证据怎么读 =====");
    expect(system).toContain("不要把弹幕位置当成广告起点");
  });

  it("系统提示要求把台词时间换算成秒", () => {
    const system = buildConversationSystemPrompt().content;
    expect(system).toContain("写 start / end 时必须换算成秒");
    expect(system).toContain("[26:48] 是 1608 秒");
  });

  it("视频信息只在 system 里发一次，user 消息不再重复", () => {
    const video = {
      title: "测试视频",
      owner: "UP",
      description: "这是简介",
      chapters: [{ start: 0, end: 60, title: "广告" }]
    };
    const system = buildConversationSystemPrompt(undefined, video).content;
    expect(system).toContain("===== 视频信息 =====");
    expect(system).toContain("标题：测试视频");
    expect(system).toContain("UP 主：UP");
    expect(system).toContain("[00:00-01:00] 广告");
    // 简介超过 200 字符时截断，与原证据包的口径一致。
    const long = buildConversationSystemPrompt(undefined, {
      ...video,
      description: "长".repeat(500)
    }).content;
    expect(long).toContain("长".repeat(200));
    expect(long).not.toContain("长".repeat(201));

    const user = buildRoundUserMessage(makePack([])).content;
    expect(user).not.toContain("视频信息");
    expect(user).not.toContain("标题：测试视频");
  });
});
