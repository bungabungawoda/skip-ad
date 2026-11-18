import { findPlayerContainer, isAdShowing } from "./platform-ad";
import { readPlayerResponseForVideo, readLengthSeconds } from "./page-data";

/**
 * YouTube 页面元数据读取：只取正片时长。
 * 优先用与当前 videoId 对得上的内联/播放器响应时长；
 * <video>.duration 只在页面身份与当前视频一致、且当前不在放广告时才用。
 */

function playerDurationIn(container: Element | null, doc: Document): number | undefined {
  const video = container?.querySelector("video") ?? (container ? null : doc.querySelector("video"));
  const duration = Number(video?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/**
 * SPA 导航后 `<video>.duration` 可能还停在上一条视频（换源比 watch 页属性晚）；
 * 广告期间 `<video>` 放的是广告，时长只有几十秒。这两种情况都不能拿它裁字幕：
 * 只有页面属性 `video-id` 与请求一致、且当前不在放广告时才算数。
 */
export function readVerifiedDuration(doc: Document, videoId: string): number | undefined {
  const pageVideoId = doc.querySelector("ytd-watch-flexy")?.getAttribute("video-id")?.trim();
  const container = findPlayerContainer(doc);
  const inlineDuration = readLengthSeconds(readPlayerResponseForVideo(videoId, doc));
  if (inlineDuration !== undefined) return inlineDuration;
  if (!pageVideoId || pageVideoId !== videoId) return undefined;
  if (container && isAdShowing(container)) return undefined;
  return playerDurationIn(container, doc);
}
