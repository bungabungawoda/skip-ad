import type { LlmMessage } from "../../../core/ports/llm/types";
import type { LlmClient } from "../../../core/ports/llm/client";
import type { CacheStore } from "../../../core/ports/cache/store";
import type { AnalysisPartial, Segment, SubtitleCue, VideoKey } from "../../../core/plugin/types";
import type { AnalysisResult } from "../../../core/analysis/types";
import {
  extractJson,
  mergeAdjacentSegments,
  normalizeKind,
  readSegmentsArray
} from "../../../core/analysis/normalize";
import { isCompleteAnalysis } from "../../../core/analysis/completeness";
import { settleRoundTable, type RoundTable } from "../../../core/analysis/conversation";
import { conversationWarnings, runConversation } from "../../../core/analysis/conversation-runner";
import { isRecord } from "../../../core/lib/record";
import { CHUNK_CHARS_DEFAULT, MIN_SEGMENT_SECONDS } from "../../../core/lib/limits";

/**
 * YouTube 字幕分析器：一个视频一个连续对话。
 *
 * 只有 YouTube 走这条：模型按字幕行 ID 回答，边界天然落在行首行尾。
 * B 站证据是字幕加弹幕、几何按秒数记，直接用 core/analysis/conversation-runner
 * 拼装（见 sites/bilibili/analysis/conversation），不经过这里。
 *
 * 分块调度、行 ID 校验与缓存策略都在这里；提示词由 ./prompt 提供。
 *
 * 三条约束：
 * - 分块严格按时间顺序、不重叠，不按播放位置重排：第 N 轮的结论
 *   依赖前 N-1 轮已经读过的内容；
 * - 模型每轮返回「到此为止的完整片段表」，可以修订、删除之前的片段；
 * - 跨块广告在已读边界处标 open，下一轮看到真实结尾后改 closed。
 *
 * 校验规则（不可信模型输出）：
 * - 引用不存在或还没读到的行 ID → 片段丢弃（防编造时间轴）；
 * - 结束行在开始行之前（颠倒边界）→ 丢弃；
 * - 证据行 ID 不在已读行里（编造证据）→ 丢弃；
 * - 片段短于 3 秒 → 丢弃；
 * - open 片段的 end 钉在已读边界，声称 closed 却越界的降级成 open。
 * 所有分块成功、时长已知且有证据才写缓存；失败、取消、中断、片段被丢弃都不写。
 */

const EPSILON = 0.01;

/** 分块内的一行：cue 加上本轮有效的行 ID。 */
export interface TranscriptLine {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptChunk {
  index: number;
  lines: TranscriptLine[];
  start: number;
  end: number;
}

/** system 提示词的静态上下文：整条视频不变，只组装一次。 */
export interface TranscriptSystemContext {
  video: VideoKey;
  durationSec: number;
}

export interface TranscriptPromptContext {
  video: VideoKey;
  durationSec: number;
  chunk: TranscriptChunk;
  /** 已读边界与轮次信息；片段 end 不得超过 readUpTo，未读到结尾的广告标 open。 */
  round: { index: number; total: number; readUpTo: number; isLast: boolean };
}

/** 把字幕行按发送顺序赋 ID（L000 递增），再按字符预算顺序分块，块间不重叠。 */
export function chunkTranscriptCues(
  cues: SubtitleCue[],
  options: { chunkChars?: number } = {}
): TranscriptChunk[] {
  const chunkChars = options.chunkChars ?? CHUNK_CHARS_DEFAULT;
  const lines: TranscriptLine[] = cues.map((cue, index) => ({
    id: `L${String(index).padStart(3, "0")}`,
    start: cue.start,
    end: cue.end,
    text: cue.text
  }));

  const chunks: TranscriptChunk[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < lines.length) {
    const group: TranscriptLine[] = [];
    let used = 0;
    let end = cursor;
    while (end < lines.length) {
      const line = lines[end];
      if (!line) break;
      if (group.length > 0 && used + line.text.length > chunkChars) break;
      group.push(line);
      used += line.text.length;
      end += 1;
    }
    if (group.length === 0) break;
    chunks.push({
      index,
      lines: group,
      start: group[0]?.start ?? 0,
      end: group[group.length - 1]?.end ?? 0
    });
    index += 1;
    cursor = end;
  }
  return chunks;
}

/**
 * 输出耗尽时把当前块拆成两个首尾相接的子块。
 * 行 ID 不变，模型仍能引用已经读过的行；拆不动返回 null。
 */
export function splitTranscriptChunk(
  chunk: TranscriptChunk
): [TranscriptChunk, TranscriptChunk] | null {
  if (chunk.lines.length < 2) return null;
  const total = chunk.lines.reduce((sum, line) => sum + line.text.length, 0);
  let used = 0;
  let cut = 1;
  for (let index = 0; index < chunk.lines.length - 1; index += 1) {
    used += chunk.lines[index]?.text.length ?? 0;
    if (used >= total / 2) {
      cut = index + 1;
      break;
    }
    cut = index + 2;
  }
  const firstLines = chunk.lines.slice(0, cut);
  const secondLines = chunk.lines.slice(cut);
  const boundary = secondLines[0]?.start;
  if (
    firstLines.length === 0 ||
    secondLines.length === 0 ||
    boundary === undefined ||
    boundary <= chunk.start ||
    boundary >= chunk.end
  ) {
    return null;
  }
  return [
    { index: chunk.index, lines: firstLines, start: chunk.start, end: boundary },
    { index: chunk.index + 1, lines: secondLines, start: boundary, end: chunk.end }
  ];
}

function readId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ReadLine {
  line: TranscriptLine;
  /** 在已读行里的顺序；用于拒绝「结束行在开始行之前」的颠倒引用。 */
  order: number;
}

function normalizeOneTranscriptSegment(
  raw: unknown,
  byId: Map<string, ReadLine>,
  readUpTo: number
): Segment | "deferred" | null {
  if (!isRecord(raw)) return null;
  const startEntry = byId.get(readId(raw.startId));
  const endEntry = byId.get(readId(raw.endId));
  // 不存在的 ID、还没读到的 ID、颠倒边界 → 直接拒绝。
  if (!startEntry || !endEntry) return null;
  if (endEntry.order < startEntry.order) return null;

  const start = startEntry.line.start;
  const endLineEnd = endEntry.line.end;
  if (!Number.isFinite(start) || !Number.isFinite(endLineEnd)) return null;
  if (start >= readUpTo - EPSILON) {
    // 起点落在已读边界上：内容还没读到，下一轮会重新给出；不计入校验丢弃。
    return start <= readUpTo + EPSILON ? "deferred" : null;
  }

  const declaredStatus = raw.status === "open" ? "open" : "closed";
  const mustClamp = declaredStatus === "open" || endLineEnd > readUpTo + EPSILON;
  let end = endLineEnd;
  let status: Segment["status"] = "closed";
  if (mustClamp) {
    // open 或越界的 closed 都不能定稿：end 钉在已读边界，策略层永不自动跳。
    end = Number(readUpTo.toFixed(2));
    status = "open";
  }
  if (end - start < MIN_SEGMENT_SECONDS) return null;

  const evidenceIds = Array.isArray(raw.evidenceIds) ? raw.evidenceIds.map(readId) : [];
  // 编造证据：证据行必须存在于已读行。
  if (evidenceIds.some((id) => !byId.has(id))) return null;
  const evidence = evidenceIds
    .map((id) => byId.get(id)?.line.text ?? "")
    .filter((text) => text.length > 0);

  const confidence = Number(raw.confidence);
  const clamped = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;
  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    kind: normalizeKind(raw.kind),
    // 无证据的片段置信度压到 0.6，策略层不会自动跳。
    confidence: evidence.length === 0 ? Math.min(clamped, 0.6) : clamped,
    evidence: evidence.slice(0, 8),
    reason: typeof raw.reason === "string" ? raw.reason.trim() : "",
    status
  };
}

/**
 * 解析一轮响应：行 ID 映射回秒数，已读边界约束几何。
 * 精确重复去掉；同类型相邻（≤1.5 秒）的片段合并成一段——
 * 否则跳到第一段结尾会停在第二段中间，而 1.5 秒内的空隙本来也没有内容价值。
 */
export function parseTranscriptRound(
  text: string,
  readUpTo: number,
  readLines: TranscriptLine[]
): RoundTable {
  const raw = extractJson(text);
  if (raw === null) return { segments: [], dropped: 0, error: "no json object found" };
  const items = readSegmentsArray(raw);
  if (items === null) {
    return { segments: [], dropped: 0, error: "missing segments array" };
  }

  const byId = new Map<string, ReadLine>(
    readLines.map((line, order) => [line.id, { line, order }])
  );
  const segments: Segment[] = [];
  let dropped = 0;
  let deferred = 0;
  for (const item of items) {
    const segment = normalizeOneTranscriptSegment(item, byId, readUpTo);
    if (segment === "deferred") {
      deferred += 1;
      continue;
    }
    if (segment) segments.push(segment);
    else dropped += 1;
  }

  const unique = new Map<string, Segment>();
  for (const segment of segments) {
    const key = `${segment.start}|${segment.end}|${segment.kind}|${segment.status ?? "closed"}`;
    if (!unique.has(key)) unique.set(key, segment);
  }
  const merged = mergeAdjacentSegments([...unique.values()]);

  // 一条都没通过校验时不能拿空表覆盖上一轮结果；起点落在已读边界的片段
  // 是正常的跨块产物，不算提交（空表判定与警告语义见 settleRoundTable）。
  return settleRoundTable({
    submitted: items.length - deferred,
    segments: merged,
    dropped
  });
}

interface TranscriptAnalyzerInput {
  video: VideoKey;
  cues: SubtitleCue[];
  durationSec: number;
}

interface TranscriptAnalyzerDeps {
  llm: LlmClient;
  cache: CacheStore;
  /** 缓存键由站点分析器算好传入，避免同一口径在两处各算一遍。 */
  cacheKey: string;
  /** system 提示词：整条视频只组装一次（含视频信息与类型改写）。 */
  buildSystemPrompt: (context: TranscriptSystemContext) => LlmMessage;
  /** 每轮的用户消息：本块行 ID 数据 + 轮次与已读边界说明。 */
  buildRoundPrompt: (context: TranscriptPromptContext) => LlmMessage;
  /** 当前服务商是否自动按前缀缓存；决定对话历史全量保留还是压缩。 */
  prefixCache?: boolean;
  now: () => number;
  signal: AbortSignal;
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  /** 每个成功分块立即发布增量结果（完整表，整表替换）。 */
  onPartial?: (partial: AnalysisPartial) => void;
}

export async function analyzeTranscript(
  input: TranscriptAnalyzerInput,
  deps: TranscriptAnalyzerDeps
): Promise<AnalysisResult> {
  const { cacheKey } = deps;

  const chunks = chunkTranscriptCues(input.cues);
  /** 已经成功读过的块；拆分后仍按实际读过的行校验引用，不能用原始块下标猜。 */
  const readChunks: TranscriptChunk[] = [];
  const system = deps.buildSystemPrompt({
    video: input.video,
    durationSec: input.durationSec
  });
  const batch = await runConversation<TranscriptChunk>({
    chunks,
    system,
    durationSec: input.durationSec,
    mode: "full",
    llm: deps.llm,
    splitChunk: splitTranscriptChunk,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.prefixCache !== undefined ? { prefixCache: deps.prefixCache } : {}),
    ...(deps.isCancelled ? { isCancelled: deps.isCancelled } : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    ...(deps.onPartial ? { onPartial: deps.onPartial } : {}),
    buildRoundPrompt: (round) =>
      deps.buildRoundPrompt({
        video: input.video,
        durationSec: input.durationSec,
        chunk: round.chunk,
        round: {
          index: round.index,
          total: round.total,
          readUpTo: round.readUpTo,
          isLast: round.isLast
        }
      }),
    parseRound: (text, round) => {
      const readLines = [...readChunks.flatMap((item) => item.lines), ...round.chunk.lines];
      const parsed = parseTranscriptRound(text, round.readUpTo, readLines);
      if (!parsed.error) readChunks.push(round.chunk);
      return parsed;
    }
  });
  const warnings = conversationWarnings(batch);

  const result: AnalysisResult = {
    videoKey: cacheKey,
    video: input.video,
    mode: "full",
    segments: batch.segments,
    warnings,
    durationSec: input.durationSec
  };
  // 完整成功判定与两个站点分析器共用同一份规则（见 isCompleteAnalysis）。
  if (
    isCompleteAnalysis({
      durationSec: input.durationSec,
      cancelled: batch.cancelled,
      failedChunks: batch.failedChunks,
      droppedChunks: batch.droppedChunks,
      hasEvidence: input.cues.length > 0
    })
  ) {
    await deps.cache.set(cacheKey, { result, createdAt: deps.now() });
  }
  return result;
}
