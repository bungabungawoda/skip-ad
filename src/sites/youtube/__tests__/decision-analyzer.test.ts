// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisServices } from "../../../core/plugin/types";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { createStorageCache } from "../../../core/ports/cache/store";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { fakeDecisionModel } from "../../../../tests/helpers/decision";
import { createYouTubeAdapter } from "../adapter";

vi.mock("../player-bridge", () => ({ requestPlayerData: vi.fn() }));

vi.mock("../panel-client", () => ({
  requestPanelCues: vi.fn(async () => ({
    status: "ok",
    cues: [
      { id: "L001", start: 0, end: 10, text: "大家好" },
      { id: "L002", start: 10, end: 20, text: "先聊一点正题" },
      { id: "L003", start: 30, end: 40, text: "本期由某品牌赞助" },
      { id: "L004", start: 40, end: 50, text: "点击链接领取优惠" },
      { id: "L005", start: 50, end: 60, text: "回到正题" }
    ]
  }))
}));

const ADS: Array<[number, number]> = [[30, 50]];

function services(): AnalysisServices {
  return {
    llm: { complete: vi.fn() } as AnalysisServices["llm"],
    decision: fakeDecisionModel(ADS),
    cache: createStorageCache(createMemoryStorageArea(), () => 1_000),
    readSettings: async () => ({
      policy: DEFAULT_POLICY,
      llmConfigured: true,
      decisionConfigured: true,
      analysisConfigured: true,
      model: "test-llm",
      decisionModel: "test-decision",
      siteSwitches: {}
    })
  };
}

describe("YouTube 决策分析器", () => {
  afterEach(() => {
    delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  });

  it("适配器提供决策分析器", () => {
    expect(createYouTubeAdapter().createDecisionAnalyzer?.(services())).toBeDefined();
  });

  it("用字幕时间轴跑决策链，产出带起止的片段", async () => {
    document.body.innerHTML = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: "abc", lengthSeconds: "120" }
    })};</script>`;
    const analyzer = createYouTubeAdapter().createDecisionAnalyzer?.(services());
    expect(analyzer).toBeDefined();
    const result = await analyzer!.analyze({
      video: { site: "youtube", videoId: "abc", partId: "main" },
      currentTime: 0,
      signal: new AbortController().signal
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      start: 30,
      end: 50,
      kind: "sponsor",
      status: "closed"
    });
    expect(result.durationSec).toBeGreaterThan(0);
  });
});
