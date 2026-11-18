import { describe, expect, it } from "vitest";
import type {
  AnalysisResult,
  AnalysisWarning,
  AnalysisWarningCode
} from "../../analysis/types";
import { sponsorSegment } from "../../../../tests/helpers/segments";
import {
  DANMAKU_WARNING_CODES,
  FATAL_WARNING_CODES,
  danmakuReason,
  derivePhase,
  emptyUiState,
  type UiErrorInfo,
  type UiPhase
} from "../state";

type PhaseInput = Parameters<typeof derivePhase>[0];
type ResultPart = Pick<AnalysisResult, "mode" | "segments" | "warnings">;

function warning(code: AnalysisWarningCode): AnalysisWarning {
  return { code, message: code };
}

function result(overrides: Partial<ResultPart> = {}): ResultPart {
  return { mode: "full", segments: [], warnings: [], ...overrides };
}

function phase(overrides: Partial<PhaseInput> = {}): UiPhase {
  return derivePhase({
    analyzing: false,
    configured: true,
    result: result(),
    error: null,
    ...overrides
  });
}

const error: UiErrorInfo = {
  kind: "network",
  message: "连接失败",
  elapsedMs: 120,
  newSegments: 0
};

describe("derivePhase — Popup 主状态机", () => {
  it("错误优先于分析中和无 Key", () => {
    expect(phase({ error, analyzing: true, configured: false })).toBe("failed");
  });

  it("致命警告（llm_failed）进入失败状态", () => {
    for (const code of FATAL_WARNING_CODES) {
      expect(phase({ result: result({ warnings: [warning(code)] }) })).toBe("failed");
    }
  });

  it("没有配置 Key 时进入 no_key，即使仍在分析中", () => {
    expect(phase({ configured: false, analyzing: true })).toBe("no_key");
  });

  it("分析中优先于结果展示", () => {
    expect(phase({ analyzing: true, result: result({ segments: [sponsorSegment(10, 20)] }) })).toBe(
      "analyzing"
    );
  });

  it("有片段时进入 ready", () => {
    expect(phase({ result: result({ segments: [sponsorSegment(10, 20)] }) })).toBe("ready");
  });

  it("仅弹幕模式进入 danmaku_only", () => {
    expect(phase({ result: result({ mode: "danmaku" }) })).toBe("danmaku_only");
  });

  it("未登录/字幕缺失类警告进入 danmaku_only", () => {
    for (const code of DANMAKU_WARNING_CODES) {
      expect(phase({ result: result({ warnings: [warning(code)] }) })).toBe("danmaku_only");
    }
  });

  it("字幕与弹幕都没读到时进入 no_context，不能显示成仅弹幕", () => {
    expect(
      phase({
        result: result({
          mode: "danmaku",
          warnings: [warning("subtitle_missing"), warning("danmaku_missing"), warning("no_context")]
        })
      })
    ).toBe("no_context");
    // YouTube 没有弹幕，无字幕时只带 subtitle_missing 与 no_context。
    expect(
      phase({ result: result({ warnings: [warning("subtitle_missing"), warning("no_context")] }) })
    ).toBe("no_context");
  });

  it("no_context 但有片段时仍然显示已就绪", () => {
    expect(
      phase({
        result: result({
          segments: [sponsorSegment(10, 20)],
          warnings: [warning("no_context")]
        })
      })
    ).toBe("ready");
  });

  it("没有片段也没有降级警告时进入 no_ads", () => {
    expect(phase()).toBe("no_ads");
  });

  it("没读到播放器数据/字幕正文时进入 source_unavailable，不是仅弹幕", () => {
    for (const code of ["player_data_unavailable", "transcript_fetch_failed"] as const) {
      expect(phase({ result: result({ warnings: [warning(code)] }) })).toBe("source_unavailable");
    }
  });

  it("B 站的字幕正文读取失败仍然退到仅弹幕", () => {
    expect(phase({ result: result({ warnings: [warning("subtitle_fetch_failed")] }) })).toBe(
      "danmaku_only"
    );
  });

  it("还没有结果时保持 analyzing", () => {
    expect(phase({ result: null })).toBe("analyzing");
  });

  it("非致命、非降级警告不改变 no_ads", () => {
    expect(phase({ result: result({ warnings: [warning("coverage_guard")] }) })).toBe("no_ads");
  });

  it("全部片段被标为不是广告后不再显示已就绪", () => {
    expect(
      phase({ result: result({ segments: [sponsorSegment(10, 20)] }), visibleSegments: 0 })
    ).toBe("no_ads");
  });

  it("分析不完整且没有片段时进入失败态，而不是无广告", () => {
    expect(phase({ incomplete: true })).toBe("failed");
    // 仅弹幕模式下同样不能显示「仅弹幕」，那是成功降级的样子。
    expect(phase({ incomplete: true, result: result({ mode: "danmaku" }) })).toBe("failed");
  });

  it("分析不完整但已有片段时仍显示已就绪，由横幅说明不完整", () => {
    expect(
      phase({ incomplete: true, result: result({ segments: [sponsorSegment(10, 20)] }) })
    ).toBe("ready");
  });
});

describe("emptyUiState", () => {
  it("给出可用于首帧渲染的初始快照", () => {
    const state = emptyUiState("https://www.bilibili.com/video/BV1");
    expect(state.href).toBe("https://www.bilibili.com/video/BV1");
    expect(state.phase).toBe("analyzing");
    expect(state.segments).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.incomplete).toBe(false);
    expect(state.progress).toBeNull();
    expect(state.stats).toEqual({ skippedCount: 0, skippedSeconds: 0, undoCount: 0 });
  });

  it("每次返回独立的 stats 与 segments", () => {
    const first = emptyUiState("a");
    const second = emptyUiState("b");
    first.stats.skippedCount = 1;
    first.segments.push({ segment: sponsorSegment(10, 20), policy: "auto" });
    expect(second.stats.skippedCount).toBe(0);
    expect(second.segments).toEqual([]);
  });
});

describe("仅弹幕的原因", () => {
  it("按用户能做的动作排序：登录优先，其次才是字幕轨的问题", () => {
    // 未登录时也会记 subtitle_missing，不能把原因说成「没有字幕」。
    expect(danmakuReason(["subtitle_missing", "not_logged_in"])).toBe("not_logged_in");
    expect(danmakuReason(["subtitle_incomplete"])).toBe("subtitle_foreign");
    expect(danmakuReason(["subtitle_fetch_failed"])).toBe("subtitle_unreadable");
    expect(danmakuReason(["subtitle_unavailable"])).toBe("subtitle_unreadable");
    expect(danmakuReason(["subtitle_missing"])).toBe("subtitle_missing");
    expect(danmakuReason([])).toBe("unknown");
  });
});
