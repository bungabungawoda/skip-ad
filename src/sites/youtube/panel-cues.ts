import type { SubtitleCue } from "../../core/plugin/types";
import { isRecord, readString } from "../../core/lib/record";

/**
 * 转写面板的参数合成与响应解析。
 *
 * 面板段只有起点，结尾用下一条的起点；超过视频时长的段直接丢掉。
 * 页面上的转写可能比当前视频更长（视频被剪过），不截断会把尾部算进正文。
 */

interface PanelSegment {
  start: number;
  text: string;
}

/** protobuf 变长整数；params 里只有 15 这类小于 128 的长度和固定的外层键会用到。 */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

/**
 * 由 videoId 反推出转写面板的 `params`。
 *
 * 实测 `qgkPCgtFd3RjRHZpWmc2OBgC` 解码是 `aa 09 0f | 0a 0b <videoId> 18 02`：
 * 外层 field 149（长度 15）套内层 `{1: videoId, 3: 2}`，与视频一一对应。
 * 也就是说参数不需要从描述区的按钮命令里读，videoId 就是全部输入。
 * 真机核对过三支视频，合成值与页面上的 params 逐字节相同。
 */
export function buildPanelParams(videoId: string): string {
  const id = new TextEncoder().encode(videoId);
  const inner = [0x0a, ...varint(id.length), ...id, 0x18, 0x02];
  const bytes = [0xaa, 0x09, ...varint(inner.length), ...inner];
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 把 "1:23" 或 "1:02:03" 解析成秒；任何一段不是数字就返回 null。 */
function parseTimestamp(text: string): number | null {
  const parts = text.split(":").map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 新 UI：`{timestamp: "m:ss", simpleText}`。 */
function modernPanelSegment(record: Record<string, unknown>): PanelSegment | null {
  const modern = record.transcriptSegmentViewModel;
  if (!isRecord(modern)) return null;
  const start = parseTimestamp(readString(modern.timestamp).trim());
  const text = readString(modern.simpleText).trim();
  return start !== null && text ? { start, text } : null;
}

function legacySnippetText(snippet: Record<string, unknown> | undefined): string {
  const runs = Array.isArray(snippet?.runs) ? snippet.runs : [];
  if (runs.length === 0) return readString(snippet?.simpleText).trim();
  return runs
    .map((run) => (isRecord(run) ? readString(run.text) : ""))
    .join("")
    .trim();
}

/** 旧 UI：`{startMs, snippet.runs[] | snippet.simpleText}`。 */
function legacyPanelSegment(record: Record<string, unknown>): PanelSegment | null {
  const legacy = record.transcriptSegmentRenderer;
  if (!isRecord(legacy)) return null;
  const startMs = Number(legacy.startMs);
  const text = legacySnippetText(isRecord(legacy.snippet) ? legacy.snippet : undefined);
  if (!Number.isFinite(startMs) || startMs < 0 || !text) return null;
  return { start: startMs / 1_000, text };
}

/** 两种结构都认，深度受限的遍历；真实嵌套在 13 层左右，阈值留余量。 */
function panelSegments(payload: unknown): PanelSegment[] {
  const segments: PanelSegment[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 24 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const segment = modernPanelSegment(record) ?? legacyPanelSegment(record);
    if (segment) segments.push(segment);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return segments;
}

export function parsePanelCues(payload: unknown): SubtitleCue[] {
  const segments = panelSegments(payload).sort((a, b) => a.start - b.start);
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    return {
      start: segment.start,
      end: next ? next.start : segment.start + 2,
      text: segment.text
    };
  });
}
