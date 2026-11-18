import type { SubtitleCue } from "../../core/plugin/types";
import { sleepUnlessAborted } from "../../core/lib/async";
import { readString } from "../../core/lib/record";
import { logInfo, logWarn } from "../../core/lib/log";
import {
  readLengthSeconds,
  readPlayerResponseForVideo,
  type PlayerResponseShape
} from "./page-data";
import { readVerifiedDuration } from "./metadata";
import { requestPlayerData, type PlayerDataResult } from "./player-bridge";
import { requestPanelCues, type PanelClientResult, type PanelClientDeps } from "./panel-client";
import type { BridgeTrack } from "./player-bridge-protocol";

/**
 * YouTube 字幕获取：转写面板（隔离世界直发）→ timedtext 轨道 →
 * 与当前 videoId 匹配的内联快照。
 *
 * 面板参数由 videoId 合成，不依赖页面的播放器数据，所以先取面板：桥缺失或
 * SPA 还没切换时也能拿到字幕。面板没内容时才问桥，用轨道列表区分
 * 「当前视频确实没有字幕」和「这次没读到」。
 *
 * 「没有字幕」只能由播放器桥的明确空轨道证明；内联快照只能补数据，
 * 不能证明当前视频没有字幕。读不到播放器数据时返回 player_data_unavailable，
 * 由界面提示重试，而不是冒充「没有字幕」。
 *
 * 轨道选择：优先人工字幕轨，没有人工轨就取第一条；不为分析额外翻译字幕。
 */

export interface TranscriptTrack {
  lang: string;
  label: string;
  /** 自动字幕（ASR）为 true。 */
  isAuto: boolean;
  baseUrl: string;
}

type TranscriptSource = "player" | "inline" | "panel";

type TranscriptPayload =
  | {
      kind: "transcript";
      cues: SubtitleCue[];
      source: TranscriptSource;
      durationSec?: number;
    }
  | { kind: "no_transcript"; source: "player"; durationSec?: number }
  | { kind: "player_data_unavailable"; detail: string; durationSec?: number }
  | { kind: "transcript_fetch_failed"; detail: string; durationSec?: number };

interface CaptionTrackShape {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  name?: { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
}

function trackLabel(track: CaptionTrackShape): string {
  const name = track.name;
  if (typeof name === "object" && name !== null) {
    if (typeof name.simpleText === "string") return name.simpleText;
    if (Array.isArray(name.runs)) {
      return name.runs.map((run) => readString(run.text)).join("");
    }
  }
  return "";
}

/** 从一份播放器响应里读轨道；不校验视频身份，调用方负责。 */
export function captionTracksFromResponse(
  response: PlayerResponseShape | undefined
): TranscriptTrack[] {
  const raw = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(raw)) return [];
  const tracks: TranscriptTrack[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const track = item as CaptionTrackShape;
    const baseUrl = readString(track.baseUrl);
    const lang = readString(track.languageCode);
    if (!baseUrl || !lang) continue;
    tracks.push({
      lang,
      label: trackLabel(track),
      isAuto: track.kind === "asr",
      baseUrl
    });
  }
  return tracks;
}

function bridgeTracksToTranscriptTracks(tracks: BridgeTrack[]): TranscriptTrack[] {
  return tracks.map((track) => ({
    lang: track.languageCode,
    label: track.name,
    isAuto: track.kind === "asr",
    baseUrl: track.baseUrl
  }));
}

/**
 * 轨道选择：第一个人工字幕轨优先，没有人工轨就取第一条轨道。
 * 播放器返回的轨道列表已经按页面语言排过序，再读播放器按钮状态不会改变结果。
 */
function chooseTranscriptTrack(tracks: TranscriptTrack[]): TranscriptTrack | null {
  const human = tracks.find((track) => !track.isAuto);
  return human ?? tracks[0] ?? null;
}

/** 解析 timedtext json3：events[] 的 tStartMs / dDurationMs / segs[].utf8。 */
export function parseJson3Track(payload: unknown): SubtitleCue[] {
  if (typeof payload !== "object" || payload === null) return [];
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const cues: SubtitleCue[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    const startMs = Number(record.tStartMs);
    if (!Number.isFinite(startMs)) continue;
    const durationMs = Number(record.dDurationMs);
    const text = Array.isArray(record.segs)
      ? record.segs
          .map((seg) => (typeof seg === "object" && seg !== null ? readString((seg as { utf8?: unknown }).utf8) : ""))
          .join("")
          .trim()
      : "";
    if (!text) continue;
    const start = startMs / 1_000;
    const end = Number.isFinite(durationMs) && durationMs > 0 ? (startMs + durationMs) / 1_000 : start + 2;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** 只依赖 ok/status/text 的最小 fetch 形状，测试可以注入假实现。 */
interface TranscriptFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface TranscriptFetchInit {
  credentials: "omit";
  signal: AbortSignal;
}

export type TranscriptFetch = (
  url: string,
  init: TranscriptFetchInit
) => Promise<TranscriptFetchResponse>;

export interface TranscriptDeps {
  doc?: Document;
  requestPlayerData?: (videoId: string, signal: AbortSignal) => Promise<PlayerDataResult>;
  requestPanelCues?: (videoId: string, deps: PanelClientDeps) => Promise<PanelClientResult>;
  fetch?: TranscriptFetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 播放器还没切到当前视频时的最长等待；测试可设为 0。 */
  bridgeDeadlineMs?: number;
  bridgeRetryMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleepUnlessAborted(ms, signal, {
    onAbort: () => new DOMException("Aborted", "AbortError")
  });
}

/**
 * 把 baseUrl 变成可下载的 json3 地址。
 * - 只允许 youtube.com 的地址，避免页面数据把扩展引到任意 host；
 * - 用参数覆盖 fmt，不盲拼 &fmt=json3；
 * - 去掉 xosf，避免字幕位置数据干扰；
 * - baseUrl 带 v 参数时，必须与当前视频一致。
 */
function buildTimedTextUrl(baseUrl: string, videoId: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl, location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "youtube.com" && !url.hostname.endsWith(".youtube.com")) return null;
  const videoParam = url.searchParams.get("v");
  if (videoParam && videoParam !== videoId) return null;
  url.searchParams.set("fmt", "json3");
  url.searchParams.delete("xosf");
  return url.toString();
}

type TimedTextBody =
  | { kind: "empty" }
  | { kind: "unparsable" }
  | { kind: "json"; payload: unknown };

/** 空正文和坏 JSON 要分开：前者是换面板的信号，后者是数据坏了。 */
function readTimedTextBody(text: string): TimedTextBody {
  if (text.trim().length === 0) return { kind: "empty" };
  try {
    return { kind: "json", payload: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unparsable" };
  }
}

/** 一次轨道尝试的结果：ok 直接返回，next 记下原因换下一条。 */
type TrackAttempt =
  | { kind: "ok"; payload: TranscriptPayload }
  | { kind: "next"; detail: string };

function nextTrack(detail: string): TrackAttempt {
  return { kind: "next", detail };
}

/** timedtext 单请求超时；超时按这条轨道失败继续下一条，不能一直挂着。 */
const TRACK_TIMEOUT_MS = 15_000;

/** 试一条字幕轨；网络错误在信号已中止时向上抛，其余记为失败。 */
async function tryTrack(
  track: TranscriptTrack,
  videoId: string,
  durationSec: number | undefined,
  source: TranscriptSource,
  signal: AbortSignal,
  fetchFn: TranscriptFetch
): Promise<TrackAttempt> {
  const url = buildTimedTextUrl(track.baseUrl, videoId);
  if (!url) return nextTrack("字幕轨地址不可用");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRACK_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  try {
    const response = await fetchFn(url, { credentials: "omit", signal: controller.signal });
    if (!response.ok) return nextTrack(`status ${response.status}`);
    const body = readTimedTextBody(await response.text());
    // 带 exp=xpe 的轨道会 200 但正文为空：这是「换转写面板再拿」的信号。
    if (body.kind === "empty") return nextTrack("字幕轨返回空正文");
    if (body.kind === "unparsable") return nextTrack("字幕轨返回的不是 JSON");
    const cues = parseJson3Track(body.payload);
    if (cues.length === 0) return nextTrack("字幕轨没有正文");
    return {
      kind: "ok",
      payload: attachDuration({ kind: "transcript", cues, source } as TranscriptPayload, durationSec)
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) return nextTrack("字幕轨请求超时");
    return nextTrack(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function fetchTracks(
  tracks: TranscriptTrack[],
  videoId: string,
  durationSec: number | undefined,
  source: TranscriptSource,
  signal: AbortSignal,
  fetchFn: TranscriptFetch
): Promise<TranscriptPayload> {
  const ordered: TranscriptTrack[] = [];
  const preferred = chooseTranscriptTrack(tracks);
  if (preferred) ordered.push(preferred);
  for (const track of tracks) if (!ordered.includes(track)) ordered.push(track);

  let lastDetail = "";
  for (const track of ordered) {
    const attempt = await tryTrack(track, videoId, durationSec, source, signal, fetchFn);
    if (attempt.kind === "ok") return attempt.payload;
    lastDetail = attempt.detail;
  }
  return attachDuration(
    {
      kind: "transcript_fetch_failed",
      detail: lastDetail || "全部字幕轨读取失败"
    } as TranscriptPayload,
    durationSec
  );
}

function panelClientOf(deps: TranscriptDeps): typeof requestPanelCues {
  return deps.requestPanelCues ?? requestPanelCues;
}

/** durationSec 可能缺：只在有值时带上，避免到处写三元。 */
function positiveDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function attachDuration<T extends { durationSec?: number }>(
  payload: T,
  durationSec: number | undefined
): T {
  return durationSec !== undefined ? { ...payload, durationSec } : payload;
}

/** 面板的失败原因并进 detail，界面上一眼能看出两条路各自为什么没拿到。 */
function withPanelReason(payload: TranscriptPayload, reason: string): TranscriptPayload {
  if (payload.kind !== "transcript_fetch_failed" && payload.kind !== "player_data_unavailable") {
    return payload;
  }
  return { ...payload, detail: `${payload.detail}；${reason}` };
}

/** 面板没有可用字幕后的解释：问桥要用轨道列表，桥不可用再退内联快照。 */
async function transcriptFromBridge(
  bridgeResult: Extract<PlayerDataResult, { status: "ok" }>,
  videoId: string,
  doc: Document,
  signal: AbortSignal,
  fetchFn: TranscriptFetch,
  panelReason: string
): Promise<TranscriptPayload> {
  const tracks = bridgeTracksToTranscriptTracks(bridgeResult.tracks);
  const durationSec = positiveDuration(bridgeResult.lengthSeconds ?? readVerifiedDuration(doc, videoId));
  if (tracks.length === 0) {
    return attachDuration({ kind: "no_transcript", source: "player" } as TranscriptPayload, durationSec);
  }

  // 面板是实测唯一可用的字幕源；timedtext 只在带播放令牌的轨道上才有正文，
  // 这里留着它是给「不再要求 PO token」留路，失败不改变结论。
  const timedText = await fetchTracks(tracks, videoId, durationSec, "player", signal, fetchFn);
  if (timedText.kind !== "transcript_fetch_failed") return timedText;
  logWarn("字幕后备也没拿到", videoId, panelReason);
  return withPanelReason(timedText, panelReason);
}

/** 桥不可用时的兜底：内联快照（videoId 对得上才用）。 */
async function transcriptWithoutBridge(
  bridgeResult: Exclude<PlayerDataResult, { status: "ok" }>,
  videoId: string,
  doc: Document,
  signal: AbortSignal,
  fetchFn: TranscriptFetch,
  panelReason: string
): Promise<TranscriptPayload> {
  const inline = readPlayerResponseForVideo(videoId, doc);
  const inlineTracks = captionTracksFromResponse(inline);
  const inlineDuration = readLengthSeconds(inline);
  const durationSec = positiveDuration(inlineDuration ?? readVerifiedDuration(doc, videoId));
  if (inlineTracks.length > 0) {
    const timedText = await fetchTracks(inlineTracks, videoId, durationSec, "inline", signal, fetchFn);
    return timedText.kind === "transcript_fetch_failed"
      ? withPanelReason(timedText, panelReason)
      : timedText;
  }

  // 没有兜底再读页面里已展开的 transcript DOM：面板内容属于哪条视频无法证明，
  // SPA 导航后面板里可能还是上一条视频的字幕（曾把 A 视频的字幕缓存到 B 名下）。
  const detail =
    bridgeResult.status === "not-ready"
      ? `播放器还停在 ${bridgeResult.videoId ?? "上一条视频"}`
      : bridgeResult.detail;
  return attachDuration(
    {
      kind: "player_data_unavailable",
      detail: `${detail || "没有读到当前播放器的字幕数据"}；${panelReason}`
    } as TranscriptPayload,
    durationSec
  );
}

export async function loadTranscript(
  videoId: string,
  signal: AbortSignal,
  deps: TranscriptDeps = {}
): Promise<TranscriptPayload> {
  const doc = deps.doc ?? document;
  const fetchFn = deps.fetch ?? (fetch as TranscriptFetch);
  const durationSec = readVerifiedDuration(doc, videoId);

  // 面板只需要 videoId：页面的播放器数据还没跟上也能先拿字幕。
  const panel = await panelClientOf(deps)(videoId, { doc, durationSec, signal });
  if (panel.status === "ok" && panel.cues.length > 0) {
    logInfo("字幕来自转写面板", videoId, panel.cues.length, "行");
    return attachDuration(
      { kind: "transcript", cues: panel.cues, source: "panel" } as TranscriptPayload,
      durationSec
    );
  }
  const panelReason = panel.status === "failed" ? panel.detail : "转写面板里没有字幕段";

  const bridge = deps.requestPlayerData ?? requestPlayerData;
  const sleepFn = deps.sleep ?? sleep;
  const deadline = Date.now() + (deps.bridgeDeadlineMs ?? 5_000);

  let bridgeResult = await bridge(videoId, signal);
  while (bridgeResult.status === "not-ready" && Date.now() < deadline) {
    await sleepFn(deps.bridgeRetryMs ?? 250, signal);
    bridgeResult = await bridge(videoId, signal);
  }

  return bridgeResult.status === "ok"
    ? transcriptFromBridge(bridgeResult, videoId, doc, signal, fetchFn, panelReason)
    : transcriptWithoutBridge(bridgeResult, videoId, doc, signal, fetchFn, panelReason);
}
