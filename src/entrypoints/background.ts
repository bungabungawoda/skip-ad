import { defineBackground } from "wxt/utils/define-background";
import type { RuntimeRequest } from "../core/ports/messages";
import { chromeStorageArea } from "../core/ports/chrome-storage";
import { createStorageCache } from "../core/ports/cache/store";
import { createLlmAbortRegistry } from "../core/ports/llm-abort";
import { createMetricsStore } from "../core/metrics/store";
import { handleMessage, type HandlerContext } from "../background/handlers";
import { errorText } from "../core/lib/error";
import { logWarn } from "../core/lib/log";

async function restrictStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    // 设置失败只记日志；Key 仍然只由后台读取，内容脚本拿不到。
    logWarn("设置 storage 访问级别失败", errorText(error));
  }
}

export default defineBackground(() => {
  void restrictStorageToTrustedContexts();
  const area = chromeStorageArea();
  const base: Omit<HandlerContext, "senderTabId"> = {
    area,
    cache: createStorageCache(area),
    aborts: createLlmAbortRegistry(),
    metrics: createMetricsStore(area)
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    void handleMessage(message as RuntimeRequest, {
      ...base,
      senderTabId: sender.tab?.id
    }).then(sendResponse);
    return true;
  });

  // Service Worker 每次启动都清一遍过期分析缓存：条目只在写入或同键读取时清，
  // 长期不启用扩展时单靠这两条路径清不干净，storage 会一直涨到配额上限。
  // 失败只记日志：清理失败不影响本次启动，下次启动会再试。
  void base.cache.trimExpired().catch((error: unknown) => {
    logWarn("过期分析缓存清理失败", errorText(error));
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void chrome.runtime.openOptionsPage();
    }
  });
});
