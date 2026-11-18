import { isRecord, readString } from "../../core/lib/record";

/**
 * 隔离世界内容脚本与 MAIN 世界播放器桥之间的消息协议。
 *
 * 只传当前视频需要的字段：videoId、时长、字幕轨。整份播放器响应包含大量
 * 与本功能无关的数据和跟踪字段，不跨世界传。
 */

export const PLAYER_BRIDGE_CHANNEL = "skip-video-ad:player-data:v1";

/** 播放器桥允许的数据来源；只用于日志和测试，不参与判定。 */
export type PlayerDataSource = "app" | "watch" | "player";

export interface BridgeTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name: string;
  vssId?: string;
}

export interface PlayerDataRequest {
  channel: typeof PLAYER_BRIDGE_CHANNEL;
  kind: "request";
  requestId: string;
  videoId: string;
}

export type PlayerDataResponse =
  | {
      channel: typeof PLAYER_BRIDGE_CHANNEL;
      kind: "response";
      requestId: string;
      status: "ok";
      videoId: string;
      source: PlayerDataSource;
      lengthSeconds?: number;
      tracks: BridgeTrack[];
    }
  | {
      channel: typeof PLAYER_BRIDGE_CHANNEL;
      kind: "response";
      requestId: string;
      status: "not-ready";
      videoId?: string;
    }
  | {
      channel: typeof PLAYER_BRIDGE_CHANNEL;
      kind: "response";
      requestId: string;
      status: "unavailable";
      detail?: string;
    };

function nonEmptyString(value: unknown): string | undefined {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function trackLabel(value: unknown): string {
  if (!isRecord(value)) return "";
  const simple = nonEmptyString(value.simpleText);
  if (simple) return simple;
  if (!Array.isArray(value.runs)) return "";
  return value.runs
    .map((run) => (isRecord(run) ? readString(run.text) : ""))
    .join("")
    .trim();
}

/** 只保留可用的轨道；缺 baseUrl 或 languageCode 的轨道直接丢弃。 */
export function sanitizeBridgeTracks(raw: unknown): BridgeTrack[] {
  if (!Array.isArray(raw)) return [];
  const tracks: BridgeTrack[] = [];
  for (const item of raw.slice(0, 64)) {
    if (!isRecord(item)) continue;
    const baseUrl = nonEmptyString(item.baseUrl);
    const languageCode = nonEmptyString(item.languageCode);
    if (!baseUrl || !languageCode) continue;
    const kind = nonEmptyString(item.kind);
    const vssId = nonEmptyString(item.vssId);
    tracks.push({
      baseUrl,
      languageCode,
      name: trackLabel(item.name),
      ...(kind ? { kind } : {}),
      ...(vssId ? { vssId } : {})
    });
  }
  return tracks;
}

export function isPlayerDataRequest(value: unknown): value is PlayerDataRequest {
  if (!isRecord(value)) return false;
  return (
    value.channel === PLAYER_BRIDGE_CHANNEL &&
    value.kind === "request" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.videoId === "string" &&
    value.videoId.length > 0
  );
}

export function isPlayerDataResponse(value: unknown): value is PlayerDataResponse {
  if (!isRecord(value)) return false;
  if (value.channel !== PLAYER_BRIDGE_CHANNEL || value.kind !== "response") return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.status === "ok") {
    return (
      typeof value.videoId === "string" &&
      value.videoId.length > 0 &&
      (value.source === "app" || value.source === "watch" || value.source === "player") &&
      Array.isArray(value.tracks)
    );
  }
  if (value.status === "not-ready") {
    return value.videoId === undefined || typeof value.videoId === "string";
  }
  if (value.status === "unavailable") {
    return value.detail === undefined || typeof value.detail === "string";
  }
  return false;
}
