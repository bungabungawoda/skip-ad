import type { RuntimeSettings } from "../../core/ports/messages";
import type { UiPhase, UiState } from "../../core/ui/state";

/** 内容脚本判断不了权限，权限态由 Popup 覆盖到内容脚本给的相位上。 */
export function resolvePhase(
  ui: UiState | null,
  settings: RuntimeSettings | null,
  siteAuthorized: boolean,
  endpointAuthorized: boolean
): UiPhase {
  if (settings && !settings.analysisConfigured) return "no_key";
  if (!siteAuthorized || !endpointAuthorized) return "permission";
  return ui?.phase ?? "analyzing";
}

export { badgeTextFor as badgeText } from "../../core/ui/badge";
