import type { EvidenceFamily, Segment, SegmentKind, SegmentStatus } from "../plugin/types";
import { EVIDENCE_FAMILIES, SEGMENT_KINDS } from "../plugin/types";
import { clamp, clampInterval } from "../lib/time";
import { isRecord } from "../lib/record";
import { logWarn } from "../lib/log";
import { MIN_SEGMENT_SECONDS, SEGMENT_GAP_SECONDS } from "../lib/limits";

interface SegmentValidation {
  segments: Segment[];
  dropped: number;
  /** 有片段因校验（太短、越界、字段非法）被丢弃时的可诊断说明。 */
  warning?: string;
  /** 全部片段都被丢弃或压根没有 JSON 时才算失败。 */
  error?: string;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeKind(value: unknown): SegmentKind {
  if (typeof value === "string" && (SEGMENT_KINDS as readonly string[]).includes(value)) {
    return value as SegmentKind;
  }
  return "unknown";
}

function normalizeFamilies(value: unknown): EvidenceFamily[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (family): family is EvidenceFamily =>
      typeof family === "string" && (EVIDENCE_FAMILIES as readonly string[]).includes(family)
  );
}

/** 只有模型显式写了 status 才落到 Segment 上；缺省时按 closed 处理。 */
function readStatus(value: unknown): SegmentStatus | undefined {
  return value === "open" || value === "closed" ? value : undefined;
}

/**
 * 思考块：MiniMax-M3 这类模型会把 `<think>...</think>` 直接写进 content，
 * 思考里常常先出现一段示例 JSON。整块去掉再找答案，避免把示例当结果。
 */
const THINK_BLOCK =
  /<\s*(?:think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|reasoning)\s*>/gi;

function stripThinking(text: string): string {
  return text.replace(THINK_BLOCK, "");
}

/** 找与 start 处括号配对的结尾；字符串里的括号和反斜杠转义不参与计数。 */
function findBracketEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
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
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

interface JsonCandidate {
  value: unknown;
  length: number;
}

/** 逐个尝试每个 `{` / `[` 起的片段，只保留能完整解析的 JSON。 */
function collectJson(text: string, open: "{" | "["): JsonCandidate[] {
  const found: JsonCandidate[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(open, index);
    if (start < 0) break;
    const end = findBracketEnd(text, start);
    if (end < 0) {
      index = start + 1;
      continue;
    }
    try {
      found.push({ value: JSON.parse(text.slice(start, end + 1)), length: end - start });
      index = end + 1;
    } catch {
      index = start + 1;
    }
  }
  return found;
}

/**
 * 从模型正文里取 JSON。
 * 不能再用「第一个 { 到最后一个 }」：思考块里也可能有 JSON，截出来的整段不是合法 JSON，
 * 会把本来有答案的分块判成解析失败。
 */
export function extractJson(text: string): unknown {
  const withoutFence = stripThinking(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const objects = collectJson(withoutFence, "{");
  // 优先取带 segments 数组的对象：思考里的示例 JSON 一般没有这个键。
  const answers = objects.filter(
    (item) => isRecord(item.value) && Array.isArray(item.value.segments)
  );
  if (answers.length > 0) return answers[answers.length - 1]?.value ?? null;
  if (objects.length > 0) {
    // 没有 segments 时取最长的对象，避免嵌套对象里只拿到内层。
    return objects.reduce((best, item) => (item.length >= best.length ? item : best)).value;
  }
  const arrays = collectJson(withoutFence, "[");
  if (arrays.length > 0) return arrays[arrays.length - 1]?.value ?? null;
  logWarn("LLM 响应里找不到 JSON", { preview: withoutFence.slice(0, 200) });
  return null;
}

export function readSegmentsArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.segments)) return raw.segments;
  return null;
}

function readSegmentRange(
  raw: Record<string, unknown>,
  duration: number
): [number, number] | null {
  const start = readNumber(raw.start);
  const end = readNumber(raw.end);
  if (start === undefined || end === undefined) return null;
  const clamped = clampInterval(start, end, duration);
  if (!clamped) return null;
  if (clamped[1] - clamped[0] < MIN_SEGMENT_SECONDS) return null;
  return [Number(clamped[0].toFixed(2)), Number(clamped[1].toFixed(2))];
}

function readEvidence(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.evidence) ? raw.evidence.map(readString).filter(Boolean) : [];
}

function normalizeOne(raw: unknown, duration: number): Segment | null {
  if (!isRecord(raw)) return null;
  const bounds = readSegmentRange(raw, duration);
  if (!bounds) return null;
  const evidence = readEvidence(raw);
  const confidence = clamp(readNumber(raw.confidence) ?? 0.5, 0, 1);
  const status = readStatus(raw.status);
  return {
    start: bounds[0],
    end: bounds[1],
    kind: normalizeKind(raw.kind),
    confidence: evidence.length === 0 ? Math.min(confidence, 0.6) : confidence,
    evidence,
    reason: readString(raw.reason),
    families: normalizeFamilies(raw.families),
    ...(status ? { status } : {})
  };
}

/**
 * 同类型片段之间允许的最大空隙：空隙不超过它就当同一次推广。
 * 1.5 秒是产品口径：口播里的停顿、换气或一句过渡语通常不到 1.5 秒，
 * 拆成两段只会让自动跳在中间闪一下。跨类型不合并——
 * 类型决定每段自动跳、标记还是关闭，合并会把两种策略混成一种。
 */
const MERGE_ADJACENT_SECONDS = SEGMENT_GAP_SECONDS;

export function mergeAdjacentSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.kind === segment.kind && segment.start - last.end <= MERGE_ADJACENT_SECONDS) {
      last.end = Math.max(last.end, segment.end);
      last.confidence = Math.max(last.confidence, segment.confidence);
      last.evidence = [...new Set([...last.evidence, ...segment.evidence])].slice(0, 8);
      last.families = [...new Set([...(last.families ?? []), ...(segment.families ?? [])])];
      if (!last.reason) last.reason = segment.reason;
      // 合并后只要有任意一段还没闭合，整段就不能当自动跳终点。
      if (last.status === "open" || segment.status === "open") last.status = "open";
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

function validateItems(raw: unknown, duration: number): SegmentValidation {
  const items = readSegmentsArray(raw);
  // 结构里没有 segments 数组不是「无广告」，而是模型没有按契约回答。
  if (items === null) {
    return { segments: [], dropped: 0, error: "missing segments array" };
  }
  const segments: Segment[] = [];
  let dropped = 0;
  for (const item of items) {
    const normalized = normalizeOne(item, duration);
    if (normalized) segments.push(normalized);
    else dropped += 1;
  }
  // 整表是集合：模型偶尔把同一条片段写两遍，精确重复直接去掉。
  // 同类型相邻的合并不在这里做：调用方要先按已读边界裁剪，再合并，
  // 否则裁剪出来的相邻两段会漏合。
  const unique = new Map<string, Segment>();
  for (const segment of segments) {
    const key = `${segment.start}|${segment.end}|${segment.kind}|${segment.status ?? "closed"}`;
    if (!unique.has(key)) unique.set(key, segment);
  }
  const sorted = [...unique.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end
  );
  return { segments: sorted, dropped };
}

/**
 * 连续对话用：模型返回的是它自己维护的权威整表，这里只做字段校验、裁剪与去重。
 * 同类型相邻片段的合并在调用方按已读边界裁剪之后再做（见 mergeAdjacentSegments）：
 * 先裁剪再合并，边界上被截成首尾相接的两段才会合到一起。
 */
export function normalizeSegmentTable(raw: unknown, duration: number): SegmentValidation {
  return validateItems(raw, duration);
}

