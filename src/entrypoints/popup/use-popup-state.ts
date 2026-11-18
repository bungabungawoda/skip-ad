import { useCallback, useEffect, useState } from "react";
import type { RuntimeSettings } from "../../core/ports/messages";
import { readRuntimeSettings } from "../../core/ports/runtime-client";
import type { UiCommandPayload } from "../../core/ui/messages";
import { fetchUiState, sendUiCommand } from "../../core/ui/messages";
import { loadSitePlugins } from "../../core/plugin/registry";
import type { UiState } from "../../core/ui/state";
import { endpointPattern } from "../../core/ports/endpoint-auth";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";

/**
 * Popup 打开时每秒刷新一次没必要：内容脚本的进度是按分块推进的，
 * 两秒一次既能看到「分析中」，又把消息与存储读取减半。
 */
const POLL_MS = 2_000;
/** 站点权限清单来自各站 site.json，新增站点不需要改 Popup。 */
const SITE_ORIGINS = loadSitePlugins().flatMap((plugin) => plugin.manifest.hostPermissions);

export type ContentScriptIssue = "unsupported" | "no_script" | null;

export type PopupCommand = (
  command: Parameters<typeof sendUiCommand>[0],
  payload?: UiCommandPayload
) => Promise<boolean>;

interface PopupState {
  ui: UiState | null;
  settings: RuntimeSettings | null;
  issue: ContentScriptIssue;
  siteAuthorized: boolean;
  endpointAuthorized: boolean;
  /** 最近一次命令失败的原因；成功后清空。 */
  commandError: string | null;
  runCommand: PopupCommand;
}

async function readPermissions(
  settings: RuntimeSettings | null
): Promise<{ site: boolean; endpoint: boolean }> {
  // 站点与端点分开查：端点查询失败不能把站点授权结论一起推翻，
  // 否则一个带端口的自定义端点会让 Popup 永远显示「权限与授权」。
  let site = true;
  try {
    site =
      SITE_ORIGINS.length === 0
        ? true
        : await chrome.permissions.contains({ origins: SITE_ORIGINS });
  } catch (error) {
    logWarn("站点权限状态检查失败，按未授权处理", errorText(error));
    site = false;
  }
  const origins = [
    ...(settings?.llmConfigured && settings.endpointOrigin ? [settings.endpointOrigin] : []),
    ...(settings?.decisionConfigured && settings.decisionEndpointOrigin
      ? [settings.decisionEndpointOrigin]
      : [])
  ];
  if (origins.length === 0) return { site, endpoint: true };
  try {
    // 权限模式不允许写端口；用与授权时同一个 endpointPattern，才能命中已授予的权限。
    const patterns = origins
      .map((origin) => endpointPattern(origin))
      .filter((pattern): pattern is string => pattern !== null);
    if (patterns.length === 0) return { site, endpoint: true };
    return { site, endpoint: await chrome.permissions.contains({ origins: patterns }) };
  } catch (error) {
    logWarn("端点权限状态检查失败，按未授权处理", errorText(error));
    return { site, endpoint: false };
  }
}

/** Popup 的数据层：轮询内容脚本快照、读取设置、检查站点与端点权限。 */
export function usePopupState(): PopupState {
  const [ui, setUi] = useState<UiState | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [issue, setIssue] = useState<ContentScriptIssue>(null);
  const [siteAuthorized, setSiteAuthorized] = useState(true);
  const [endpointAuthorized, setEndpointAuthorized] = useState(true);
  const [commandError, setCommandError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [response, runtimeSettings] = await Promise.all([
      fetchUiState(),
      readRuntimeSettings().catch((error: unknown) => {
        logWarn("读取运行时设置失败", errorText(error));
        return null;
      })
    ]);
    setSettings(runtimeSettings);
    if (response.ok && response.value) {
      setUi(response.value);
      setIssue(null);
    } else {
      setUi(null);
      // 页面本身支持但内容脚本没响应时，刷新页面通常就能解决；不要误导成「不支持的页面」。
      setIssue(
        response.ok
          ? "no_script"
          : response.error.kind === "no_content_script" || response.error.kind === "empty"
            ? "no_script"
            : "unsupported"
      );
    }
    const granted = await readPermissions(runtimeSettings);
    setSiteAuthorized(granted.site);
    setEndpointAuthorized(granted.endpoint);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const runCommand = useCallback<PopupCommand>(async (command, payload) => {
    const response = await sendUiCommand(command, payload);
    if (response.ok) {
      if (response.value) setUi(response.value);
      setCommandError(null);
      return true;
    }
    // 命令失败不能静默：用户点了「重新分析」或「不是广告」，要看到没生效。
    setCommandError(response.error.message);
    logWarn("Popup 命令失败", { command, error: response.error.message });
    return false;
  }, []);

  return {
    ui,
    settings,
    issue,
    siteAuthorized,
    endpointAuthorized,
    commandError,
    runCommand
  };
}
