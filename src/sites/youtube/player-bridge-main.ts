import { isRecord, readString } from "../../core/lib/record";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import {
  PLAYER_BRIDGE_CHANNEL,
  isPlayerDataRequest,
  sanitizeBridgeTracks,
  type PlayerDataResponse,
  type PlayerDataSource
} from "./player-bridge-protocol";

/**
 * MAIN 世界播放器桥：只读当前页面里的播放器响应，按请求的 videoId 校验后
 * 回给隔离世界。不修改页面、不调用 chrome.*、不缓存响应。
 *
 * 转写面板不由这里代发：内容脚本的 fetch 与页面同源，直发 `get_panel`
 * 稳定 200；扩展 origin 的请求才会被拦成 403。这里只留隔离世界读不到的东西：
 * 页面 JS 挂在 ytd-app / 播放器上的播放器响应。
 *
 * 数据源按可靠性排序：
 * 1. ytd-app.data.playerResponse：SPA 导航后会更新，Tampermonkey 字幕下载脚本同款；
 * 2. ytd-watch-flexy.data.playerResponse：页面级兜底；
 * 3. #movie_player.getPlayerResponse()：播放器方法兜底。
 */

interface PlayerResponseLike {
  videoDetails?: {
    videoId?: unknown;
    lengthSeconds?: unknown;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown;
    };
  };
}

interface Candidate {
  source: PlayerDataSource;
  response: PlayerResponseLike;
}

type AppElement = HTMLElement & {
  data?: { playerResponse?: unknown };
};

type PlayerElement = HTMLElement & {
  getPlayerResponse?: () => unknown;
};

function asPlayerResponse(value: unknown): PlayerResponseLike | undefined {
  return isRecord(value) ? (value as PlayerResponseLike) : undefined;
}

function readCandidates(doc: Document): Candidate[] {
  const candidates: Candidate[] = [];

  const app = doc.querySelector("ytd-app") as AppElement | null;
  const appResponse = asPlayerResponse(app?.data?.playerResponse);
  if (appResponse) candidates.push({ source: "app", response: appResponse });

  const watch = doc.querySelector("ytd-watch-flexy") as AppElement | null;
  const watchResponse = asPlayerResponse(watch?.data?.playerResponse);
  if (watchResponse) candidates.push({ source: "watch", response: watchResponse });

  const player = doc.querySelector("#movie_player") as PlayerElement | null;
  if (typeof player?.getPlayerResponse === "function") {
    try {
      const playerResponse = asPlayerResponse(player.getPlayerResponse());
      if (playerResponse) candidates.push({ source: "player", response: playerResponse });
    } catch (error) {
      logWarn("YouTube 读取播放器响应失败", errorText(error));
    }
  }

  return candidates;
}

/** 纯函数，测试直接调用；返回 null 表示收到的不是本协议的请求。 */
export function handlePlayerDataRequest(
  value: unknown,
  doc: Document = document
): PlayerDataResponse | null {
  if (!isPlayerDataRequest(value)) return null;

  const candidates = readCandidates(doc);
  let firstVideoId: string | undefined;
  let malformedTracks = false;

  for (const candidate of candidates) {
    const videoId = readString(candidate.response.videoDetails?.videoId).trim();
    if (!videoId) continue;
    firstVideoId ??= videoId;
    if (videoId !== value.videoId) continue;

    const rawLength = Number(candidate.response.videoDetails?.lengthSeconds);
    const lengthSeconds =
      Number.isFinite(rawLength) && rawLength > 0 ? rawLength : undefined;
    const rawTracks =
      candidate.response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const tracks = sanitizeBridgeTracks(rawTracks);
    if (Array.isArray(rawTracks) && rawTracks.length > 0 && tracks.length === 0) {
      // 结构不完整不能当成「没有字幕」；换下一个来源再试。
      malformedTracks = true;
      continue;
    }

    return {
      channel: PLAYER_BRIDGE_CHANNEL,
      kind: "response",
      requestId: value.requestId,
      status: "ok",
      videoId,
      source: candidate.source,
      ...(lengthSeconds !== undefined ? { lengthSeconds } : {}),
      tracks
    };
  }

  if (malformedTracks) {
    return {
      channel: PLAYER_BRIDGE_CHANNEL,
      kind: "response",
      requestId: value.requestId,
      status: "unavailable",
      detail: "播放器返回的字幕轨结构不完整"
    };
  }
  if (firstVideoId) {
    return {
      channel: PLAYER_BRIDGE_CHANNEL,
      kind: "response",
      requestId: value.requestId,
      status: "not-ready",
      videoId: firstVideoId
    };
  }
  return {
    channel: PLAYER_BRIDGE_CHANNEL,
    kind: "response",
    requestId: value.requestId,
    status: "unavailable",
    detail: "页面里没有播放器响应"
  };
}

/**
 * 在 MAIN 世界安装监听器。页面可以伪造 postMessage，但字幕轨本来就是页面数据；
 * 这里只做只读查询，并把请求的 videoId 绑定到当前播放器响应。
 */
function postReply(target: Window, response: unknown): void {
  try {
    target.postMessage(response, target.location.origin);
  } catch (error) {
    logWarn("YouTube 播放器桥回包失败", errorText(error));
  }
}

export function installPlayerBridge(target: Window = window): () => void {
  const listener = (event: MessageEvent): void => {
    // 真实 Chrome 里同窗口 postMessage 的 source 是本窗口；合成事件与测试环境
    // （happy-dom）里 source 可能为 null，也放行。iframe 等其他窗口的消息
    // source 是别的窗口，会被拒。
    if (event.source !== target && event.source !== null && event.source !== undefined) return;
    if (event.origin && event.origin !== target.location.origin) return;

    const response = handlePlayerDataRequest(event.data, target.document);
    if (response) postReply(target, response);
  };

  target.addEventListener("message", listener);
  return () => target.removeEventListener("message", listener);
}
