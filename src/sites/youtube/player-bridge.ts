import {
  PLAYER_BRIDGE_CHANNEL,
  isPlayerDataResponse,
  sanitizeBridgeTracks,
  type BridgeTrack,
  type PlayerDataRequest,
  type PlayerDataResponse,
  type PlayerDataSource
} from "./player-bridge-protocol";

/**
 * 隔离世界客户端：向 MAIN 世界播放器桥请求当前视频的播放器数据。
 *
 * 页面可能没有桥、播放器还没切到当前视频、或者桥回包被页面脚本干扰。
 * 这里只做一次请求 + 超时，重试与降级由 transcript 的读取顺序负责。
 */

export type PlayerDataResult =
  | {
      status: "ok";
      videoId: string;
      source: PlayerDataSource;
      lengthSeconds?: number;
      tracks: BridgeTrack[];
    }
  | { status: "not-ready"; videoId?: string }
  | { status: "unavailable"; detail: string };

interface PlayerDataRequestDeps {
  win?: Window;
  timeoutMs?: number;
  randomId?: () => string;
}

type WaitOutcome<T> = { kind: "reply"; data: T } | { kind: "timeout" } | { kind: "aborted" };

interface WaitOptions<T> {
  win: Window;
  requestId: string;
  matches: (data: unknown) => data is T;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * 挂上监听等 MAIN 世界的回包；超时与取消都归到 outcome，由调用方决定
 * 拒绝还是降级。监听器在 Promise 构造时同步挂上，调用方随后再 post。
 */
function waitForBridgeReply<T extends { requestId: string }>(
  options: WaitOptions<T>
): Promise<WaitOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {};
    const settle = (outcome: WaitOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timerRef.id !== undefined) clearTimeout(timerRef.id);
      options.win.removeEventListener("message", onMessage);
      options.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => settle({ kind: "aborted" });
    const onMessage = (event: MessageEvent): void => {
      if (event.origin && event.origin !== options.win.location.origin) return;
      const data = event.data;
      if (!options.matches(data) || data.requestId !== options.requestId) return;
      settle({ kind: "reply", data });
    };
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.win.addEventListener("message", onMessage);
    options.signal.addEventListener("abort", onAbort, { once: true });
    timerRef.id = setTimeout(() => settle({ kind: "timeout" }), options.timeoutMs);
  });
}

function bridgeTarget(deps: { win?: Window }): Window {
  return deps.win ?? window;
}

function postRequest(win: Window, request: unknown): string | null {
  try {
    win.postMessage(request, win.location.origin);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function randomRequestId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 把桥的 ok 回包折成隔离世界的结果；身份字段原样透传，坏结构不冒充没有字幕。 */
function playerDataFromResponse(
  data: Extract<PlayerDataResponse, { status: "ok" }>
): PlayerDataResult {
  const tracks = sanitizeBridgeTracks(data.tracks);
  if (data.tracks.length > 0 && tracks.length === 0) {
    return { status: "unavailable", detail: "播放器桥返回的字幕轨结构不完整" };
  }
  return {
    status: "ok",
    videoId: data.videoId,
    source: data.source,
    ...(data.lengthSeconds !== undefined ? { lengthSeconds: data.lengthSeconds } : {}),
    tracks
  };
}

export async function requestPlayerData(
  videoId: string,
  signal: AbortSignal,
  deps: PlayerDataRequestDeps = {}
): Promise<PlayerDataResult> {
  const win = bridgeTarget(deps);
  const request: PlayerDataRequest = {
    channel: PLAYER_BRIDGE_CHANNEL,
    kind: "request",
    requestId: (deps.randomId ?? randomRequestId)(),
    videoId
  };
  const waitController = new AbortController();
  const forwardAbort = (): void => waitController.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) waitController.abort();
  const wait = waitForBridgeReply({
    win,
    requestId: request.requestId,
    matches: isPlayerDataResponse,
    timeoutMs: deps.timeoutMs ?? 800,
    signal: waitController.signal
  });
  const postError = postRequest(win, request);
  if (postError) {
    waitController.abort();
    signal.removeEventListener("abort", forwardAbort);
    return { status: "unavailable", detail: postError };
  }
  try {
    const outcome = await wait;
    if (outcome.kind === "aborted") throw new DOMException("Aborted", "AbortError");
    if (outcome.kind === "timeout") return { status: "unavailable", detail: "播放器桥没有响应" };

    const data = outcome.data;
    if (data.status === "ok") return playerDataFromResponse(data);
    if (data.status === "not-ready") {
      return { status: "not-ready", ...(data.videoId !== undefined ? { videoId: data.videoId } : {}) };
    }
    return { status: "unavailable", detail: data.detail ?? "播放器桥不可用" };
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
}
