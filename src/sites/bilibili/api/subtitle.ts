import type { SubtitleTrack } from "../types";
import type { SubtitleCue } from "../../../core/plugin/types";

const TRACK_PRIORITY = ["ai-zh", "zh-cn", "zh-hans", "zh", "zh-hant", "ai-en"];

function trackPriority(lan: string): number {
  const normalized = lan.trim().toLowerCase();
  const index = TRACK_PRIORITY.indexOf(normalized);
  if (index >= 0) return index;
  if (normalized.startsWith("zh")) return TRACK_PRIORITY.length;
  return TRACK_PRIORITY.length + 1;
}

export function chooseSubtitleTrack(tracks: SubtitleTrack[]): SubtitleTrack | undefined {
  const usable = tracks.filter((track) => track.url.trim().length > 0);
  if (usable.length === 0) return undefined;
  return [...usable].sort((a, b) => trackPriority(a.lan) - trackPriority(b.lan))[0];
}

/** 字幕结尾允许超出视频时长的倍数。 */
const SUBTITLE_END_RATIO = 1.2;
/** 字幕结尾允许超出视频时长的绝对秒数：长视频按比例放得太宽，再加一道上限。 */
const SUBTITLE_END_SLACK_SECONDS = 300;

/** 字幕里结束最晚的那一句的结束时间；没有字幕时返回 0。 */
export function lastCueEnd(cues: SubtitleCue[]): number {
  return cues.reduce((max, cue) => (Number.isFinite(cue.end) ? Math.max(max, cue.end) : max), 0);
}

/**
 * 字幕是否比视频还长。同一条视频的字幕不可能超出视频结尾，超了就是拿错了数据。
 * 允许一点余量：1.2 倍以内，且最多多 5 分钟。接口给的时长是取整的，片尾也可能
 * 有彩蛋或黑屏；超出这个范围就只可能是别的更长视频的字幕。
 * 字幕比视频短不算异常：片尾可能是音乐、空镜或收尾字幕，本来就没有台词。
 */
export function subtitleOutrunsVideo(cues: SubtitleCue[], duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const end = lastCueEnd(cues);
  return end > duration * SUBTITLE_END_RATIO || end > duration + SUBTITLE_END_SLACK_SECONDS;
}

/** 取 URL 的文件名部分（去掉 query 与 hash）。 */
function urlBasename(url: string): string {
  const path = url.trim().split(/[?#]/)[0] ?? "";
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** AI 字幕文件名开头的归属前缀：连续 12 位以上数字（<aid><cid>）。 */
const OWNER_PREFIX = /^(\d{12,})/;

/**
 * 字幕轨的归属：
 * - owned：文件名前缀就是本视频的 aid+cid，文件只可能是这一分 P 自己的字幕
 * - unknown：文件名是纯 hash（人工字幕、翻译轨），读不出归属
 * - foreign：文件名前缀是另一条视频的 aid+cid
 */
type SubtitleTrackOwnership = "owned" | "unknown" | "foreign";

/**
 * 判断字幕轨属于谁。B 站 AI 字幕的文件名是 <aid><cid><hash>，前缀就是归属：
 * 接口串数据时，拿回来的文件名前缀是另一条视频的 aid+cid，用它就能当场识破。
 * 人工字幕的文件名是纯 hash（如 5f2c1e9a.json），开头可能也是数字，
 * 所以只有连续 12 位以上数字才当作归属前缀，读不出归属时记为 unknown。
 */
export function subtitleTrackOwnership(
  track: SubtitleTrack,
  aid: number,
  cid: number
): SubtitleTrackOwnership {
  if (!Number.isFinite(aid) || aid <= 0) return "unknown";
  const owned = OWNER_PREFIX.exec(urlBasename(track.url));
  if (!owned) return "unknown";
  return (owned[1] ?? "").startsWith(`${aid}${cid}`) ? "owned" : "foreign";
}

/** 字幕轨是否属于这条视频；读不出归属时放行。 */
function trackBelongsToVideo(track: SubtitleTrack, aid: number, cid: number): boolean {
  return subtitleTrackOwnership(track, aid, cid) !== "foreign";
}

/** 只留下属于本视频的轨道，再按语言优先级挑一条。 */
export function pickSubtitleTrack(
  tracks: SubtitleTrack[],
  aid: number,
  cid: number
): SubtitleTrack | undefined {
  return chooseSubtitleTrack(tracks.filter((track) => trackBelongsToVideo(track, aid, cid)));
}

export function normalizeSubtitleUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

function mapCue(item: unknown): SubtitleCue | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as { from?: unknown; to?: unknown; content?: unknown };
  const start = Number(record.from);
  const end = Number(record.to);
  const text = typeof record.content === "string" ? record.content.trim() : "";
  if (!Number.isFinite(start) || !Number.isFinite(end) || !text || end < start) return null;
  return { start, end, text };
}

export function parseSubtitlePayload(raw: unknown): SubtitleCue[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("subtitle payload is not an object");
  }
  const body = (raw as { body?: unknown }).body;
  if (!Array.isArray(body)) {
    throw new Error("subtitle payload has no body array");
  }
  const cues: SubtitleCue[] = [];
  for (const item of body) {
    const cue = mapCue(item);
    if (cue) cues.push(cue);
  }
  return cues.sort((a, b) => a.start - b.start);
}
