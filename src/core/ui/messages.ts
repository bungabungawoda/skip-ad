import { loadSitePlugins, findSitePlugin } from "../plugin/registry";
import { errorText } from "../lib/error";
import { logWarn } from "../lib/log";
import type { UiState } from "./state";
import { t } from "../i18n";

/** 当前标签页是否有站点插件处理（首页、搜索页、其它网站都不处理）。 */
function isSupportedPage(href: string): boolean {
  try {
    return findSitePlugin(new URL(href), loadSitePlugins()) !== null;
  } catch {
    return false;
  }
}

/**
 * Popup 与内容脚本之间的消息，不经过后台，不进入 RuntimeRequest。
 * Popup 用 chrome.tabs.query 取 active tab 的 id，再 chrome.tabs.sendMessage 发送，
 * 两者都不需要 tabs 权限。
 */

export type UiCommandName =
  | "skipToEnd"
  | "markNotAd"
  | "reanalyze"
  | "undoSkip"
  | "cancelAnalysis";

export interface UiCommandPayload {
  key?: string;
}

export type UiRequest =
  | { type: "ui.getState" }
  | ({ type: "ui.command"; command: UiCommandName } & UiCommandPayload);

export type UiResponse =
  | { ok: true; value: UiState | null }
  | { ok: false; error: { kind: string; message: string } };

export function isUiRequest(message: unknown): message is UiRequest {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === "ui.getState" || type === "ui.command";
}

/**
 * 后台 → 内容脚本：设置有改动，重读一次。
 * storage.local 设了 TRUSTED_CONTEXTS，内容脚本收不到 onChanged，
 * 只能由后台在写完后主动通知，否则改类型策略要等下一次分析才生效。
 */
const SETTINGS_CHANGED_TYPE = "settings.changed";

interface SettingsChangedMessage {
  type: typeof SETTINGS_CHANGED_TYPE;
}

export function isSettingsChangedMessage(
  message: unknown
): message is SettingsChangedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === SETTINGS_CHANGED_TYPE
  );
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch (error) {
    logWarn("查询当前标签页失败", errorText(error));
    return null;
  }
}

/** 发消息给当前标签页的内容脚本。不是视频页的标签页静默忽略；视频页发送失败才记日志。 */
export async function sendUiRequest(request: UiRequest): Promise<UiResponse> {
  const tab = await getActiveTab();
  if (tab?.id === undefined) {
    return { ok: false, error: { kind: "no_tab", message: t("ui.noTab") } };
  }
  // 没有 tabs 权限时 tab.url 只在本项目授权的站点页面上有值，其它页面读不到地址；
  // 地址缺失或没有插件匹配（首页、搜索页、其它网站）都当成不支持的站点，静默返回。
  if (!isSupportedPage(tab.url ?? "")) {
    return {
      ok: false,
      error: { kind: "unsupported_page", message: t("ui.unsupportedPage") }
    };
  }
  try {
    const response = (await chrome.tabs.sendMessage(tab.id, request)) as UiResponse | undefined;
    if (!response) {
      return {
        ok: false,
        error: {
          kind: "no_content_script",
          message: t("ui.noContentResult")
        }
      };
    }
    return response;
  } catch (error) {
    logWarn("内容脚本消息失败", errorText(error));
    return {
      ok: false,
      error: {
        kind: "no_content_script",
        message: t("ui.noContentResponse")
      }
    };
  }
}

export async function fetchUiState(): Promise<UiResponse> {
  return sendUiRequest({ type: "ui.getState" });
}

export async function sendUiCommand(
  command: UiCommandName,
  payload: UiCommandPayload = {}
): Promise<UiResponse> {
  return sendUiRequest({ type: "ui.command", command, ...payload });
}
