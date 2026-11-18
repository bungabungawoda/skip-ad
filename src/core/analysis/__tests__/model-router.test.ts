import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../types";
import { createModelAnalyzer } from "../model-router";
import type { SegmentAnalyzer, SegmentAnalyzerRun } from "../../plugin/types";
import type { RuntimeSettings } from "../../ports/messages";
import { DEFAULT_POLICY } from "../../policy/policy";
import { LlmError } from "../../ports/llm/errors";

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    policy: DEFAULT_POLICY,
    llmConfigured: true,
    decisionConfigured: true,
    analysisConfigured: true,
    model: "llm-model",
    decisionModel: "decision-model",
    siteSwitches: {},
    ...overrides
  };
}

function result(): AnalysisResult {
  return {
    videoKey: "bilibili:BV1:1",
    video: { site: "bilibili", videoId: "BV1", partId: "1" },
    mode: "full",
    segments: [],
    warnings: [],
    durationSec: 600
  };
}

function analyzer(run: () => Promise<AnalysisResult>): SegmentAnalyzer & {
  analyze: ReturnType<typeof vi.fn>;
} {
  return { analyze: vi.fn(run) } as SegmentAnalyzer & {
    analyze: ReturnType<typeof vi.fn>;
  };
}

function run(): SegmentAnalyzerRun {
  return {
    video: { site: "bilibili", videoId: "BV1", partId: "1" },
    currentTime: 0,
    signal: new AbortController().signal
  };
}

describe("主分析器选择", () => {
  it("默认优先决策模型", async () => {
    const decision = analyzer(async () => result());
    const llm = analyzer(async () => result());
    const composed = createModelAnalyzer({
      llm,
      decision,
      readSettings: async () => settings()
    });
    await composed?.analyze(run());
    expect(decision.analyze).toHaveBeenCalledTimes(1);
    expect(llm.analyze).not.toHaveBeenCalled();
  });

  it("用户选择 LLM 优先时只跑 LLM", async () => {
    const decision = analyzer(async () => result());
    const llm = analyzer(async () => result());
    const composed = createModelAnalyzer({
      llm,
      decision,
      readSettings: async () => settings({ preferLlm: true })
    });
    await composed?.analyze(run());
    expect(llm.analyze).toHaveBeenCalledTimes(1);
    expect(decision.analyze).not.toHaveBeenCalled();
  });

  it("优先链没有配置时用另一条", async () => {
    const decision = analyzer(async () => result());
    const composed = createModelAnalyzer({
      llm: null,
      decision,
      readSettings: async () => settings({ llmConfigured: false, preferLlm: true })
    });
    await composed?.analyze(run());
    expect(decision.analyze).toHaveBeenCalledTimes(1);
  });

  it("选中的链失败时直接报错，不改用另一条", async () => {
    const decision = analyzer(async () => {
      throw new LlmError("network down", "network");
    });
    const llm = analyzer(async () => result());
    const composed = createModelAnalyzer({
      llm,
      decision,
      readSettings: async () => settings()
    });
    await expect(composed?.analyze(run())).rejects.toMatchObject({ kind: "network" });
    expect(llm.analyze).not.toHaveBeenCalled();
  });

  it("没有配置任何分析器时返回 null", () => {
    expect(
      createModelAnalyzer({
        llm: null,
        decision: null,
        readSettings: async () => settings()
      })
    ).toBeNull();
  });
});
