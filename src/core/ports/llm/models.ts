/**
 * 模型解析：从服务商的 /models 里挑一个这次要用的模型名。
 *
 * 规则：先排除非对话模型与专用推理模型，再让便宜档排前面，同档取发布时间最新的。
 * 判定任务要的是快、稳、便宜，不是最强推理；这个顺序就是为它定的。
 */

import { isRecord } from "../../lib/record";

export interface ModelEntry {
  id: string;
  created?: number;
}

const NON_CHAT = [
  "embed",
  "rerank",
  "tts",
  "whisper",
  "asr",
  "speech",
  "audio",
  "realtime",
  "image",
  "vision",
  "dall-e",
  "moderation",
  "ocr",
  "video",
  "sora"
];

const REASONING_MARKERS = ["reasoner", "reasoning", "-r1", "think"];
const REASONING_PREFIXES = ["o1", "o3", "o4"];
const CHEAP_TIERS = ["mini", "flash", "turbo", "lite", "small", "nano"];

function tail(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT.some((marker) => lower.includes(marker));
}

function isReasoningOnly(id: string): boolean {
  const lower = id.toLowerCase();
  if (REASONING_PREFIXES.some((prefix) => tail(lower).startsWith(prefix))) return true;
  return REASONING_MARKERS.some((marker) => lower.includes(marker));
}

function isCheapTier(id: string): boolean {
  const lower = id.toLowerCase();
  return CHEAP_TIERS.some((marker) => lower.includes(marker));
}

function byCheapThenCreated(a: ModelEntry, b: ModelEntry): number {
  const cheap = Number(isCheapTier(b.id)) - Number(isCheapTier(a.id));
  if (cheap !== 0) return cheap;
  const created = (b.created ?? 0) - (a.created ?? 0);
  if (created !== 0) return created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 从候选里挑一个；全被排除或列表为空时用兜底名。 */
export function pickModel(entries: ModelEntry[], fallback: string): string {
  const usable = entries.filter((entry) => isChatModel(entry.id) && !isReasoningOnly(entry.id));
  if (usable.length === 0) return fallback;
  return [...usable].sort(byCheapThenCreated)[0]?.id ?? fallback;
}

/** 解析 /models 的常见形状：{ data: [{ id, created }] }。形状不认识返回 undefined。 */
export function readModelList(payload: unknown): ModelEntry[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  const entries: ModelEntry[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    const created = typeof item.created === "number" ? item.created : undefined;
    entries.push(created === undefined ? { id: item.id } : { id: item.id, created });
  }
  return entries;
}
