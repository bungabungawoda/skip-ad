import { describe, expect, it, vi } from "vitest";
import { createStorageCache } from "../../../../core/ports/cache/store";
import { DEFAULT_POLICY } from "../../../../core/policy/policy";
import type { BiliClient } from "../../api/client";
import type { PlayerInfo } from "../../types";
import { createMemoryStorageArea } from "../../../../../tests/helpers/memory-storage";
import { makeClient, track } from "../../../../../tests/helpers/analysis";
import { fakeDecisionModel } from "../../../../../tests/helpers/decision";
import {
  analyzeVideoWithDecision,
  buildDanmakuLines,
  buildDecisionTimeline,
  type DecisionAnalyzeDeps
} from "../decision-analyzer";

function makeDecisionDeps(overrides: Partial<DecisionAnalyzeDeps> = {}): DecisionAnalyzeDeps {
  return {
    client: overrides.client ?? makeClient(),
    decision: overrides.decision ?? fakeDecisionModel([[90, 120]]),
    cache: overrides.cache ?? createStorageCache(createMemoryStorageArea(), () => 1_000),
    policy: DEFAULT_POLICY,
    promptVersion: "d2",
    model: "gemini-decision-1",
    now: () => 1_000,
    sleep: async () => undefined
  };
}

describe("时间轴组装", () => {
  it("台词在前、弹幕在后，空台词丢掉", () => {
    const lines = buildDecisionTimeline(
      [
        { start: 10, end: 20, text: "正片开始" },
        { start: 20, end: 25, text: "   " },
        { start: 25, end: 30, text: "本期由赞助商提供" }
      ],
      []
    );
    expect(lines.map((line) => [line.start, line.end, line.kind])).toEqual([
      [10, 20, "cue"],
      [25, 30, "cue"]
    ]);
  });

  it("弹幕按 5 秒一桶，同桶去重计数，每桶最多 6 条", () => {
    const items = [
      { time: 101, mode: 1, text: "广告" },
      { time: 102, mode: 1, text: "广告" },
      { time: 103, mode: 1, text: "恰饭" },
      ...Array.from({ length: 8 }, (_, index) => ({
        time: 110,
        mode: 1,
        text: `第二条 ${index}`
      }))
    ];
    const lines = buildDanmakuLines(items);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ start: 100, end: 105, kind: "note" });
    expect(lines[0]?.text).toContain("广告 ×2");
    expect(lines[0]?.text).toContain("恰饭");
    expect(lines[1]?.text.split("｜")).toHaveLength(6);
  });
});

describe("决策模型分析器", () => {
  it("一段口播广告：起止对齐台词，类别来自复核", async () => {
    const result = await analyzeVideoWithDecision({ bvid: "BV1test", page: 1 }, makeDecisionDeps());
    expect(result.mode).toBe("full");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      start: 90,
      end: 120,
      kind: "sponsor",
      status: "closed"
    });
    expect(result.videoKey).toContain("bilibili-decision");
    expect(result.durationSec).toBe(600);
  });

  it("第二次命中缓存，不再请求播放器", async () => {
    const client = makeClient();
    const deps = makeDecisionDeps({ client });
    const first = await analyzeVideoWithDecision({ bvid: "BV1test", page: 1 }, deps);
    const second = await analyzeVideoWithDecision({ bvid: "BV1test", page: 1 }, deps);
    expect(second).toEqual(first);
    expect(client.getPlayer).toHaveBeenCalledTimes(1);
  });

  it("没有字幕轨时退到仅弹幕模式，仍然能判出片段", async () => {
    const client: BiliClient = makeClient({
      getPlayer: vi.fn(async (): Promise<PlayerInfo> => ({
        isLogin: true,
        subtitles: [],
        chapters: []
      }))
    });
    const result = await analyzeVideoWithDecision(
      { bvid: "BV1test", page: 1 },
      makeDecisionDeps({ client })
    );
    expect(result.mode).toBe("danmaku");
    expect(result.segments).toHaveLength(1);
    // 没有台词可吸附，边界落在细扫窗口上，允许几秒误差。
    const segment = result.segments[0];
    expect(segment?.start).toBeGreaterThanOrEqual(85);
    expect(segment?.start).toBeLessThanOrEqual(95);
    expect(segment?.end).toBeGreaterThanOrEqual(115);
    expect(segment?.end).toBeLessThanOrEqual(125);
  });

  it("定位失败时留下 llm_failed 警告，不写缓存", async () => {
    let call = 0;
    const decision = fakeDecisionModel([[90, 120]]);
    const flaky = {
      ...decision,
      async decide(request: Parameters<typeof decision.decide>[0]) {
        call += 1;
        if (call > 1) throw new Error("timeout");
        return decision.decide(request);
      }
    };
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const result = await analyzeVideoWithDecision(
      { bvid: "BV1test", page: 1 },
      makeDecisionDeps({ decision: flaky, cache })
    );
    expect(result.warnings.map((warning) => warning.code)).toContain("llm_failed");
    expect(result.segments).toEqual([]);
  });
});

describe("仅弹幕缓存的复用口径", () => {
  it("有字幕轨但正文为空时，第二次也复用仅弹幕缓存，与主分析器口径一致", async () => {
    // 第一遍：轨道存在但接口没给出正文 → 走仅弹幕，结果写入缓存。
    const emptyBody = vi.fn(async (): Promise<PlayerInfo> => ({
      isLogin: true,
      subtitles: [track],
      chapters: []
    }));
    const client1 = makeClient({ getPlayer: emptyBody, getSubtitle: vi.fn(async () => []) });
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const first = await analyzeVideoWithDecision(
      { bvid: "BV1test", page: 1 },
      makeDecisionDeps({ client: client1, cache })
    );
    expect(first.mode).toBe("danmaku");

    // 第二遍：同样的证据形态。主分析器把它当「没有可用字幕正文」复用缓存，
    // 决策分析器此前只看 hasSubtitleTrack，会重新发起完整分析。
    const decision = makeDecisionDeps().decision;
    const decideSpy = vi.spyOn(decision, "decide");
    const client2 = makeClient({ getPlayer: emptyBody, getSubtitle: vi.fn(async () => []) });
    const second = await analyzeVideoWithDecision(
      { bvid: "BV1test", page: 1 },
      makeDecisionDeps({ client: client2, decision, cache })
    );
    expect(second).toEqual(first);
    expect(decideSpy).not.toHaveBeenCalled();
  });
});
