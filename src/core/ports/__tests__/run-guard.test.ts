import { describe, expect, it } from "vitest";
import { canApplyResult, shouldClearRun, shouldStartAnalysis } from "../run-guard";

describe("会话令牌贯穿异步回写", () => {
  const video = { id: "same-element" };

  it("切换分 P 复用同一 video 元素时，旧结果不得写入新会话", () => {
    expect(
      canApplyResult({ runToken: 2, analyzing: true, cancelled: false, video }, 1, video)
    ).toBe(false);
    expect(
      canApplyResult({ runToken: 1, analyzing: true, cancelled: false, video }, 1, video)
    ).toBe(true);
  });

  it("旧分析的 finally 不得清掉新分析的 analyzing 标志", () => {
    expect(
      shouldClearRun({ runToken: 2, analyzing: true, cancelled: false, video }, 1)
    ).toBe(false);
    expect(
      shouldClearRun({ runToken: 2, analyzing: true, cancelled: false, video }, 2)
    ).toBe(true);
  });

  it("取消后 tick 不再立刻重复发起分析", () => {
    const base = {
      analyzing: false,
      cancelled: true,
      resultPresent: false,
      nextAnalysisAt: 0,
      now: 1_000
    };
    expect(shouldStartAnalysis(base)).toBe(false);
    expect(shouldStartAnalysis({ ...base, cancelled: false })).toBe(true);
    expect(shouldStartAnalysis({ ...base, cancelled: false, analyzing: true })).toBe(false);
    expect(shouldStartAnalysis({ ...base, cancelled: false, resultPresent: true })).toBe(false);
    expect(
      shouldStartAnalysis({ ...base, cancelled: false, nextAnalysisAt: 2_000, now: 1_000 })
    ).toBe(false);
  });
});
