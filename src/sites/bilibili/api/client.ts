import type { DanmakuData, SubtitleTrack, PlayerInfo, VideoInfo, VideoPage } from "../types";
import type { SubtitleCue } from "../../../core/plugin/types";
import type { Chapter } from "../../../core/plugin/types";
import { parseDanmakuXml } from "./danmaku";
import { normalizeSubtitleUrl, parseSubtitlePayload } from "./subtitle";
import { asArray, isRecord, readNumber, readString } from "../../../core/lib/record";
import type { FetchLike } from "../../../core/lib/http";

const API_BASE = "https://api.bilibili.com";

/**
 * 单次请求超时。接口正常是几百毫秒到几秒；没有上限时，一次卡住的弹幕请求
 * 会让整条分析一直停在「分析中」，只能等用户取消或切走。
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** 调用方的取消信号与超时合并：任一触发都让 fetch 中止。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface BiliClientOptions {
  /** 单次请求超时；测试用它验证卡住时会被中止。 */
  timeoutMs?: number;
}

export class BiliApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiliApiError";
  }
}

export interface BiliClient {
  getVideo(bvid: string, page: number, signal?: AbortSignal): Promise<VideoInfo>;
  /** 播放器接口按 aid + cid 取字幕轨。 */
  getPlayer(aid: number, cid: number, signal?: AbortSignal): Promise<PlayerInfo>;
  getDanmaku(cid: number, signal?: AbortSignal): Promise<DanmakuData>;
  getSubtitle(track: SubtitleTrack, signal?: AbortSignal): Promise<SubtitleCue[]>;
}

function mapChapter(value: unknown): Chapter | null {
  if (!isRecord(value)) return null;
  const start = readNumber(value.from, Number.NaN);
  const end = readNumber(value.to, Number.NaN);
  const title = readString(value.content).trim();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !title) return null;
  return { start, end, title };
}

function mapPage(value: unknown): VideoPage | null {
  if (!isRecord(value)) return null;
  const cid = readNumber(value.cid, Number.NaN);
  const page = readNumber(value.page, Number.NaN);
  if (!Number.isFinite(cid) || !Number.isFinite(page)) return null;
  const pageDuration = readNumber(value.duration, Number.NaN);
  const mapped: VideoPage = { cid, page };
  if (Number.isFinite(pageDuration) && pageDuration > 0) mapped.duration = pageDuration;
  return mapped;
}

function mapTrack(value: unknown): SubtitleTrack | null {
  if (!isRecord(value)) return null;
  const lan = readString(value.lan).trim();
  if (!lan) return null;
  return {
    lan,
    url: readString(value.subtitle_url)
  };
}

async function requestJson(
  fetchImpl: FetchLike,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal: withTimeout(signal, timeoutMs)
  });
  if (!response.ok) {
    throw new BiliApiError(`Bilibili request failed with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new BiliApiError("Bilibili response is not an object");
  }
  const code = readNumber(payload.code, 0);
  if (code !== 0) {
    throw new BiliApiError(`Bilibili returned code ${code}`);
  }
  const data = payload.data;
  if (!isRecord(data)) {
    throw new BiliApiError("Bilibili response has no data object");
  }
  return data;
}

async function fetchVideo(
  fetchImpl: FetchLike,
  bvid: string,
  page: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<VideoInfo> {
  const data = await requestJson(
    fetchImpl,
    `/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    timeoutMs,
    signal
  );
  const pages = asArray(data.pages)
    .map(mapPage)
    .filter((item): item is VideoPage => item !== null)
    .sort((a, b) => a.page - b.page);
  const fallbackCid = readNumber(data.cid, Number.NaN);
  const totalDuration = readNumber(data.duration, Number.NaN);
  let selected: VideoPage | undefined;
  if (pages.length > 0) {
    selected = pages.find((item) => item.page === page);
    if (!selected) {
      // 请求的分 P 不存在时必须报错：静默分析第一个分 P 会把结果写到错误的时间轴。
      throw new BiliApiError(`Bilibili video has no page ${page}`);
    }
  } else if (page !== 1) {
    // 没有分 P 列表时 data.cid 只能证明是第 1 个分 P；请求其他分 P 无法确认归属，
    // 静默回退会把结果写到错误的时间轴。
    throw new BiliApiError(`Bilibili video has no page list to confirm page ${page}`);
  }
  const cid = selected?.cid ?? fallbackCid;
  if (!Number.isFinite(cid)) {
    throw new BiliApiError("Bilibili video has no cid");
  }
  // 多 P 视频的 data.duration 是所有分 P 之和，优先用所选分 P 的时长。
  // 多 P 里所选分 P 缺时长时按未知处理：拿总时长会撑出错误的时间轴。
  const duration =
    selected?.duration !== undefined && selected.duration > 0
      ? selected.duration
      : pages.length > 1
        ? 0
        : totalDuration;
  return {
    // 字幕接口只认 aid；读不到时记 0，由 fetchPlayer 报明确错误再降级，不让整个分析中断。
    aid: readNumber(data.aid, 0),
    bvid,
    cid,
    title: readString(data.title),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    owner: isRecord(data.owner) ? readString(data.owner.name) : "",
    description: readString(data.desc),
    chapters: [],
    isLogin: false
  };
}

async function fetchPlayer(
  fetchImpl: FetchLike,
  aid: number,
  cid: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PlayerInfo> {
  if (!Number.isFinite(aid) || aid <= 0) {
    throw new BiliApiError("Bilibili video has no aid");
  }
  // 播放器自己也走 wbi/v2，并且只认 aid + cid。/x/player/v2?bvid= 在高并发与
  // 稍后再看上下文里会把别的视频的字幕轨一起返回，是「分析成无广告」的源头。
  const data = await requestJson(
    fetchImpl,
    `/x/player/wbi/v2?aid=${encodeURIComponent(String(aid))}&cid=${encodeURIComponent(String(cid))}`,
    timeoutMs,
    signal
  );
  const subtitle = isRecord(data.subtitle) ? data.subtitle : {};
  const tracks = asArray(subtitle.subtitles)
    .map(mapTrack)
    .filter((item): item is SubtitleTrack => item !== null);
  const chapters = asArray(data.view_points)
    .map(mapChapter)
    .filter((item): item is Chapter => item !== null)
    .sort((a, b) => a.start - b.start);
  return {
    isLogin: readNumber(data.login_mid) > 0,
    subtitles: tracks,
    chapters
  };
}

async function fetchDanmaku(
  fetchImpl: FetchLike,
  cid: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<DanmakuData> {
  const response = await fetchImpl(
    `${API_BASE}/x/v1/dm/list.so?oid=${encodeURIComponent(String(cid))}`,
    {
      credentials: "include",
      headers: { Accept: "text/xml" },
      signal: withTimeout(signal, timeoutMs)
    }
  );
  if (!response.ok) {
    throw new BiliApiError(`Danmaku request failed with status ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    const payload: unknown = await response.json();
    const code = isRecord(payload) ? readNumber(payload.code, 0) : 0;
    throw new BiliApiError(`Danmaku request returned code ${code}`);
  }
  return parseDanmakuXml(await response.text());
}

async function fetchSubtitle(
  fetchImpl: FetchLike,
  track: SubtitleTrack,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SubtitleCue[]> {
  const url = normalizeSubtitleUrl(track.url);
  if (!url) throw new BiliApiError("Subtitle track has no URL");
  const response = await fetchImpl(url, {
    credentials: "omit",
    signal: withTimeout(signal, timeoutMs)
  });
  if (!response.ok) {
    throw new BiliApiError(`Subtitle request failed with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  return parseSubtitlePayload(payload);
}

export function createBiliClient(
  fetchImpl: FetchLike = fetch,
  options: BiliClientOptions = {}
): BiliClient {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    getVideo: (bvid, page, signal) => fetchVideo(fetchImpl, bvid, page, timeoutMs, signal),
    getPlayer: (aid, cid, signal) => fetchPlayer(fetchImpl, aid, cid, timeoutMs, signal),
    getDanmaku: (cid, signal) => fetchDanmaku(fetchImpl, cid, timeoutMs, signal),
    getSubtitle: (track, signal) => fetchSubtitle(fetchImpl, track, timeoutMs, signal)
  };
}
