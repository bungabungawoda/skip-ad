/**
 * YouTube 页面内联播放器数据。
 *
 * 内容脚本默认运行在隔离世界，读不到页面主世界给 window 添加的
 * `ytInitialPlayerResponse`。页面里真正共享的是 DOM，所以这里同时支持：
 * 1. window 全局（MAIN world 或测试环境）；
 * 2. 页面内联 script 文本里的 `ytInitialPlayerResponse = {...}`（隔离世界）。
 *
 * 找不到或结构不合法时返回 undefined，调用方继续走 DOM 兜底。
 */

import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";
import { readString } from "../../core/lib/record";

export interface PlayerResponseShape {
  videoDetails?: {
    videoId?: unknown;
    title?: unknown;
    author?: unknown;
    lengthSeconds?: unknown;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown;
    };
  };
}

/** 从一段脚本文本里截取 `marker = {...}` 的完整 JSON 对象。 */
function extractAssignedObject(text: string, marker: string): unknown {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      return JSON.parse(text.slice(start, index + 1));
    } catch (error) {
      // 内联数据存在但截取失败：静默退 DOM 兜底会让排障无线索，留下原因。
      logWarn("YouTube 内联播放器数据解析失败，退回 DOM 兜底", errorText(error));
      return null;
    }
  }
  return null;
}

export function readPlayerResponse(doc: Document = document): PlayerResponseShape | undefined {
  const view = doc.defaultView as { ytInitialPlayerResponse?: PlayerResponseShape } | null;
  if (typeof view?.ytInitialPlayerResponse === "object" && view.ytInitialPlayerResponse !== null) {
    return view.ytInitialPlayerResponse;
  }

  for (const script of doc.querySelectorAll("script")) {
    const text = script.textContent ?? "";
    if (!text.includes("ytInitialPlayerResponse")) continue;
    const parsed = extractAssignedObject(text, "ytInitialPlayerResponse");
    if (typeof parsed === "object" && parsed !== null) return parsed as PlayerResponseShape;
  }
  return undefined;
}

/**
 * 只返回属于指定视频的内联快照。
 *
 * 首屏 ytInitialPlayerResponse 是一次性的：SPA 导航后它还停在上一条视频。
 * 内联数据只能补数据，不能用来证明「当前视频没有字幕」。
 */
export function readPlayerResponseForVideo(
  videoId: string,
  doc: Document = document
): PlayerResponseShape | undefined {
  const response = readPlayerResponse(doc);
  if (!response) return undefined;
  const actual = readString(response.videoDetails?.videoId).trim();
  return actual.length > 0 && actual === videoId ? response : undefined;
}

/** 从播放器响应里读正片时长；缺失或非法时返回 undefined。 */
export function readLengthSeconds(
  response: PlayerResponseShape | undefined
): number | undefined {
  const value = Number(response?.videoDetails?.lengthSeconds);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
