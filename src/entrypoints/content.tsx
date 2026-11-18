import "../styles/globals.css";
import { defineContentScript } from "wxt/utils/define-content-script";
import { loadSitePlugins, findSitePlugin } from "../core/plugin/registry";
import type { SegmentAnalyzer, SiteAdapter, SitePlugin } from "../core/plugin/types";
import { SessionController } from "../core/session/controller";
import { createRuntimeAnalysisServices } from "../core/session/services";
import { createModelAnalyzer } from "../core/analysis/model-router";
import { useAnalysisStore } from "../stores/analysis";
import { useSessionStore } from "../stores/session";
import { segmentKey } from "../core/player/segment-skipper";
import { recordSkip, recordUndo } from "../core/ports/runtime-client";
import { mountPlayerOverlay } from "../content/overlay-mount";
import { errorText } from "../core/lib/error";
import { logInfo, logWarn } from "../core/lib/log";

/**
 * 内容脚本入口：只做 URL 匹配、选插件、启动会话控制器。
 * 播放器绑定、分析调度、跳过执行与浮层挂载都在 SessionController。
 */

function activate(plugin: SitePlugin): {
  adapter: SiteAdapter;
  analyzer: SegmentAnalyzer | null;
} {
  const adapter = plugin.create();
  const services = createRuntimeAnalysisServices();
  const analyzer = createModelAnalyzer({
    llm: adapter.createSegmentAnalyzer?.(services) ?? null,
    decision: adapter.createDecisionAnalyzer?.(services) ?? null,
    readSettings: services.readSettings
  });
  return { adapter, analyzer };
}

export default defineContentScript({
  // 构建时由 build:manifestGenerated 用各站 site.json 的 contentMatches 替换这份占位声明。
  matches: ["https://www.bilibili.com/video/*", "https://www.bilibili.com/list/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",
  main(ctx) {
    logInfo("content script 启动");
    let url: URL;
    try {
      url = new URL(window.location.href);
    } catch (error) {
      logWarn("当前地址无法解析，内容脚本退出", errorText(error));
      return;
    }
    const plugin = findSitePlugin(url, loadSitePlugins());
    if (!plugin) return;

    const { adapter, analyzer } = activate(plugin);
    const controller = new SessionController({
      adapter,
      siteId: plugin.id,
      analyzer,
      readStats: () => useSessionStore.getState().stats,
      mountOverlay: mountPlayerOverlay,
      callbacks: {
        publish() {
          useAnalysisStore.getState().setState(controller.snapshot());
        },
        showToast(segment, mode, options) {
          useSessionStore.getState().showToast({
            segmentKey: segmentKey(segment),
            kind: segment.kind,
            start: segment.start,
            // 自动跳可能跨过相邻片段：Toast 的时间段按实际落点显示。
            end: options?.end ?? segment.end,
            confidence: segment.confidence,
            mode,
            manual: options?.manual === true,
            ...(options?.undoTo === undefined ? {} : { undoTo: options.undoTo })
          });
        }
      }
    });
    // 本次会话的统计进内存 store，累计统计写后台；两者失败互不影响。
    controller.onSkipRecorded = (segment, skippedEnd) => {
      const seconds = Math.max(0, (skippedEnd ?? segment.end) - segment.start);
      useSessionStore.getState().recordSkip(seconds);
      void recordSkip(seconds).catch((error: unknown) => {
        logWarn("累计跳过统计写入失败", errorText(error));
      });
    };
    controller.onUndoRecorded = () => {
      useSessionStore.getState().recordUndo();
      void recordUndo().catch((error: unknown) => {
        logWarn("累计撤销统计写入失败", errorText(error));
      });
    };
    controller.onPlatformAdSkipped = (seconds) => {
      const value = seconds ?? 0;
      useSessionStore.getState().recordSkip(value);
      void recordSkip(value).catch((error: unknown) => {
        logWarn("平台广告统计写入失败", errorText(error));
      });
    };
    controller.start(ctx);
    ctx.onInvalidated(() => controller.stop());
  }
});
