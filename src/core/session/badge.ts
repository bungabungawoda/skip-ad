import type { Session } from "./session-state";
import { derivePhase } from "../ui/state";
import { badgeTextFor } from "../ui/badge";
import { hasIncompleteWarnings } from "../analysis/completeness";
import { errorText } from "../lib/error";
import { logWarn } from "../lib/log";

/**
 * 工具栏角标：从会话状态算出文案，再让后台写 chrome.action。
 * 内容脚本没有 tabs 权限，也不直接改角标。
 */
export class BadgeReporter {
  constructor(
    private readonly deps: {
      session(): Session;
      analysisEnabled(): boolean;
    }
  ) {}

  private text(): string {
    const session = this.deps.session();
    const phase = derivePhase({
      analyzing: session.analyzing,
      configured: session.configured,
      result: session.result,
      error: session.error,
      visibleSegments: session.views.length,
      incomplete: session.result ? hasIncompleteWarnings(session.result.warnings) : false,
      analysisEnabled: this.deps.analysisEnabled()
    });
    return badgeTextFor(phase, session.views.length);
  }

  send(): void {
    const text = this.text();
    void chrome.runtime
      .sendMessage({ type: "badge.set", text })
      .catch((error: unknown) => logWarn("角标更新失败", { text, error: errorText(error) }));
  }
}
