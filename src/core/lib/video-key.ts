import type { VideoKey } from "../plugin/types";

/**
 * 网站无关的视频标识落成字符串：会话识别、缓存键与本机记录都用它。
 * 按 CONTEXT.md 的约定，不要用完整 URL 当标识。
 */
export function videoKeyString(video: VideoKey): string {
  return `${video.site}:${video.videoId}:${video.partId}`;
}
