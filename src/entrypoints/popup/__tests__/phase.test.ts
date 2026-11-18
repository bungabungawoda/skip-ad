import { describe, expect, it } from "vitest";
import type { RuntimeSettings } from "../../../core/ports/messages";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { emptyUiState, type UiState } from "../../../core/ui/state";
import { badgeText, resolvePhase } from "../phase";

function ui(overrides: Partial<UiState> = {}): UiState {
  return { ...emptyUiState("https://www.youtube.com/watch?v=abc"), ...overrides };
}

function settings(llmConfigured: boolean): RuntimeSettings {
  return {
    policy: DEFAULT_POLICY,
    llmConfigured,
    decisionConfigured: false,
    analysisConfigured: llmConfigured,
    siteSwitches: {}
  };
}

describe("resolvePhase", () => {
  it("没配置 Key 时优先显示 no_key", () => {
    expect(resolvePhase(ui(), settings(false), true, true)).toBe("no_key");
  });

  it("站点或端点未授权时显示 permission", () => {
    expect(resolvePhase(ui({ phase: "ready" }), settings(true), false, true)).toBe("permission");
    expect(resolvePhase(ui({ phase: "ready" }), settings(true), true, false)).toBe("permission");
  });

  it("其余情况沿用内容脚本给的相位", () => {
    expect(resolvePhase(ui({ phase: "failed" }), settings(true), true, true)).toBe("failed");
    expect(resolvePhase(null, settings(true), true, true)).toBe("analyzing");
    expect(resolvePhase(ui({ phase: "ready" }), null, true, true)).toBe("ready");
  });
});

describe("badgeText", () => {
  it("就绪显示片段数，无广告显示 0，进行中显示省略号，无上下文显示空集符号", () => {
    expect(badgeText("ready", 3)).toBe("AD 3");
    expect(badgeText("no_ads", 0)).toBe("AD 0");
    expect(badgeText("analyzing", 0)).toBe("…");
    expect(badgeText("danmaku_only", 0)).toBe("…");
    // 字幕数据没读到：可能是桥/正文拉取失败，同样不能显示 AD 0。
    expect(badgeText("source_unavailable", 0)).toBe("!");
    // 没有可读内容时不能显示 AD 0，那会被理解成「这条视频没有广告」。
    expect(badgeText("no_context", 0)).toBe("∅");
    expect(badgeText("failed", 0)).toBe("!");
    expect(badgeText("no_key", 0)).toBe("!");
    expect(badgeText("permission", 0)).toBe("!");
  });
});
