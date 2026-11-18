import type {
  Disposable,
  OverlayAdapter,
  PlayerAdapter,
  SiteAdapter,
  VideoKey
} from "../../core/plugin/types";
import type { PlatformAdAdapter } from "../../core/platform-ad/types";
import { createHtmlVideoPlayer } from "../../core/player/html-video";
import {
  createPlatformAdFastForward,
  findPlayerContainer,
  isAdShowing
} from "./platform-ad";
import { createYouTubeSegmentAnalyzer } from "./analysis/analyzer";
import { createYouTubeDecisionAnalyzer } from "./analysis/decision-analyzer";

/**
 * YouTube 适配器：watch 页解析、SPA 导航观察、播放器定位与平台广告端口。
 * 视频标识：videoId 取 v 查询参数，单视频 partId 固定为 main。
 */

const WATCH_PATH = "/watch";

/**
 * 浮层挂载点：播放器容器与原生进度条。
 * 色块按 0–时长画在进度条轨道上，Toast 与撤销胶囊挂在播放器容器内。
 * 这两个选择器要在真机上复核，YouTube 改版时只影响浮层，不影响自动跳。
 */
const overlay: OverlayAdapter = {
  anchor: ".html5-video-player",
  progressAnchor: ".ytp-progress-bar",
  // 轨道本身就是胶囊宿主，不需要再往上找祖先。
  snapAnchor: ".ytp-progress-bar",
  // 已播条在 .ytp-chapters-container（z-index 32）里，滑块是 43。
  // 42 能盖住已播条和时间标记，又不会挡住滑块。
  progressMarksZIndex: 42
};

export function resolveYouTubeVideo(url: URL): VideoKey | null {
  if (url.hostname !== "www.youtube.com") return null;
  if (url.pathname !== WATCH_PATH) return null;
  const videoId = url.searchParams.get("v");
  if (!videoId) return null;
  return { site: "youtube", videoId, partId: "main" };
}

/** 观察 SPA 导航：yt-navigate-finish 为主，URL 轮询兜底由会话控制器承担。 */
function observeYouTubeNavigation(onChange: () => void): Disposable {
  const handler = (): void => onChange();
  document.addEventListener("yt-navigate-finish", handler, true);
  return {
    dispose() {
      document.removeEventListener("yt-navigate-finish", handler, true);
    }
  };
}

function createPlatformAdAdapter(): PlatformAdAdapter {
  const fastForward = createPlatformAdFastForward();
  // 播放器会把兜底倍速重置回 1：ratechange/volumechange 事件里立即重挂，
  // 比轮询快得多。媒体事件不冒泡，但 document 上的捕获监听能收到 video 的。
  const maintain = (): void => {
    const container = findPlayerContainer();
    if (container) fastForward.maintain(container);
  };
  document.addEventListener("ratechange", maintain, true);
  document.addEventListener("volumechange", maintain, true);
  return {
    observe() {
      const container = findPlayerContainer();
      if (!container) return null;
      const showingAd = isAdShowing(container);
      // 广告结束：立即恢复快进前的倍速与静音，不等下一次快进。
      if (!showingAd) fastForward.restore(container);
      return { showingAd };
    },
    fastForward() {
      const container = findPlayerContainer();
      if (!container) return { acted: false };
      return fastForward.step(container);
    },
    container() {
      return findPlayerContainer();
    },
    dispose() {
      const container = findPlayerContainer();
      if (container) fastForward.restore(container);
      document.removeEventListener("ratechange", maintain, true);
      document.removeEventListener("volumechange", maintain, true);
    }
  };
}

export function createYouTubeAdapter(): SiteAdapter {
  const fallbackPlayer = createHtmlVideoPlayer();
  const player: PlayerAdapter = {
    // 优先取播放器容器内的 video；容器缺失（页面加载早期）退回页面唯一的 video。
    findVideo() {
      return findPlayerContainer()?.querySelector("video") ?? fallbackPlayer.findVideo();
    }
  };
  return {
    resolveVideo(url: URL): VideoKey | null {
      return resolveYouTubeVideo(url);
    },
    observeNavigation(onChange: () => void): Disposable {
      return observeYouTubeNavigation(onChange);
    },
    player,
    overlay,
    createPlatformAdController() {
      return createPlatformAdAdapter();
    },
    createSegmentAnalyzer(services) {
      return createYouTubeSegmentAnalyzer(services);
    },
    createDecisionAnalyzer(services) {
      return createYouTubeDecisionAnalyzer(services);
    }
  };
}
