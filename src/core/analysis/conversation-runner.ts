import type { LlmClient } from "../ports/llm/client";
import { LlmError } from "../ports/llm/client";
import type { LlmMessage } from "../ports/llm/types";
import type { AnalysisPartial, Segment } from "../plugin/types";
import type { AnalysisMode, AnalysisWarning } from "./types";
import { assistantTableMessage, compactHistory, finalizeTable } from "./conversation";
import { errorText } from "../lib/error";
import { logWarn } from "../lib/log";

/** 一个连续对话分块只需要这三样：顺序、起止时间。 */
export interface ConversationChunk {
  index: number;
  start: number;
  end: number;
}

export interface ParsedConversationRound {
  segments: Segment[];
  dropped: number;
  /** 本轮完全不可用：保留上一轮的表并中断对话。 */
  error?: string;
  /** 有片段被校验丢弃：表还能用，但结果不完整。 */
  warning?: string;
}

export interface ConversationRound<Chunk extends ConversationChunk = ConversationChunk> {
  chunk: Chunk;
  index: number;
  total: number;
  readUpTo: number;
  isLast: boolean;
}

export interface ConversationRunnerDeps<Chunk extends ConversationChunk> {
  chunks: Chunk[];
  system: LlmMessage;
  durationSec: number;
  mode: AnalysisMode;
  llm: LlmClient;
  /**
   * 输出耗尽且扩容后仍失败时，把当前块拆成两个首尾相接的子块。
   * 返回 null 表示已经拆不动；不传时按原逻辑中断对话。
   */
  splitChunk?: (chunk: Chunk) => [Chunk, Chunk] | null;
  signal?: AbortSignal;
  /** 当前服务商是否自动按请求前缀缓存；决定历史全量保留还是压缩。 */
  prefixCache?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  onPartial?: (partial: AnalysisPartial) => void;
  /** 站点自己的每轮用户消息；证据包、行 ID 和提示词排版都在这里。 */
  buildRoundPrompt: (round: ConversationRound<Chunk>) => LlmMessage;
  /** 站点自己的解析器；把一轮回复变成完整片段表。 */
  parseRound: (text: string, round: ConversationRound<Chunk>) => ParsedConversationRound;
  /** 站点自己的表变换，例如给 B 站片段补证据族；缺省不改表。 */
  transformTable?: (segments: Segment[], round: ConversationRound<Chunk>) => Segment[];
}

export interface ConversationBatch {
  /** 对话结束时模型维护的完整片段表；不是各分块结果的拼接。 */
  segments: Segment[];
  failedChunks: number;
  /** 合法 JSON 但有片段被校验丢弃的轮数：结果不完整，同样不能写缓存。 */
  droppedChunks: number;
  authFailed: boolean;
  cancelled: boolean;
  /** 连续对话在第几轮中断；后续内容没读过，不能跳着继续问。 */
  stoppedAt?: number;
  /** 每个失败轮次的可诊断原因。 */
  failures: string[];
}

function chunkFailure(round: ConversationRound, reason: string): string {
  const { chunk } = round;
  return `chunk ${round.index} [${chunk.start}-${chunk.end}s]: ${reason}`;
}

/** 取消信号既可以来自 AbortSignal，也可以来自会话层的取消回调。 */
function isAborted(deps: { signal?: AbortSignal; isCancelled?: () => boolean }): boolean {
  return deps.signal?.aborted === true || deps.isCancelled?.() === true;
}

/** 拆出来的两块必须首尾相接，并且都比原块小；否则不认这次拆分。 */
function isProgressSplit<Chunk extends ConversationChunk>(
  parent: Chunk,
  split: [Chunk, Chunk]
): boolean {
  const [first, second] = split;
  return (
    first.start === parent.start &&
    second.end === parent.end &&
    Math.abs(first.end - second.start) < 1e-6 &&
    first.end > parent.start &&
    second.end > first.end
  );
}

/** 单次分析最多拆几块：拆分本身有成本，必须留一个硬上限。 */
const MAX_CHUNK_SPLITS = 32;

/**
 * 一个视频 = 一个连续对话。
 *
 * 两个站点的差异只在提示词和解析器：这里统一处理按块循环、历史压缩、
 * 前缀缓存分支、重试、增量下发、输出耗尽拆分、取消与整表定稿。
 * 输出耗尽时先拆小当前块；其余失败才中断：后面的内容没读过，
 * 跳着问只会得到断档的时间轴。
 */
export async function runConversation<Chunk extends ConversationChunk>(
  deps: ConversationRunnerDeps<Chunk>
): Promise<ConversationBatch> {
  const { chunks, system } = deps;
  const messages: LlmMessage[] = [system];
  const failures: string[] = [];
  let segments: Segment[] = [];
  let failedChunks = 0;
  let droppedChunks = 0;
  let authFailed = false;
  let cancelled = false;
  let stoppedAt: number | undefined;
  let done = 0;
  let splitCount = 0;

  const roundOf = (chunk: Chunk, index: number, total: number): ConversationRound<Chunk> => {
    return {
      chunk,
      index,
      total,
      readUpTo: chunk.end,
      isLast: index === total - 1
    };
  };
  // 队列会在输出耗尽时把一个块换成两个子块；cursor 指向当前要处理的块。
  const pending: Chunk[] = [...chunks];
  let cursor = 0;
  while (cursor < pending.length) {
    if (isAborted(deps)) {
      cancelled = true;
      break;
    }
    const chunk = pending[cursor];
    if (!chunk) break;
    const round = roundOf(chunk, cursor, pending.length);
    const user = deps.buildRoundPrompt(round);

    let text: string;
    let request: LlmMessage[] = [];
    try {
      // 有自动前缀缓存的服务商保留完整历史：改写旧轮消息会掐断缓存前缀。
      // 没有的服务商压缩历史，限制上下文随轮数增长。
      const history = deps.prefixCache ? messages : compactHistory(messages, pending.length);
      request = [...history, user];
      text = await deps.llm.complete(
        request,
        {
          ...(deps.signal ? { signal: deps.signal } : {}),
          videoDurationMs: deps.durationSec * 1000
        }
      );
    } catch (error) {
      const kind = error instanceof LlmError ? error.kind : "network";
      const reason = `${kind}: ${errorText(error)}`;
      // 先扩容，仍不够就拆当前块。拆出来的子块沿用同一张片段表，
      // 只是每次让模型读更少的内容，推理和正文都能回到输出预算内。
      if (kind === "truncated" && deps.splitChunk && splitCount < MAX_CHUNK_SPLITS) {
        const split = deps.splitChunk(chunk);
        if (split && isProgressSplit(chunk, split)) {
          pending.splice(cursor, 1, split[0], split[1]);
          splitCount += 1;
          logWarn("LLM 输出耗尽，拆分当前分块后重试", {
            chunk: chunk.index,
            from: `${chunk.start}-${chunk.end}s`,
            to: [`${split[0].start}-${split[0].end}s`, `${split[1].start}-${split[1].end}s`]
          });
          continue;
        }
      }
      failedChunks += 1;
      failures.push(chunkFailure(round, reason));
      if (kind === "auth") authFailed = true;
      logWarn("LLM 连续对话请求失败", chunkFailure(round, reason));
      stoppedAt = round.index;
      break;
    }

    const parsed = deps.parseRound(text, round);
    if (parsed.error) {
      failedChunks += 1;
      failures.push(chunkFailure(round, parsed.error));
      logWarn("LLM 连续对话响应解析失败", chunkFailure(round, parsed.error));
      stoppedAt = round.index;
      break;
    }
    if (parsed.dropped > 0) {
      droppedChunks += 1;
      failures.push(
        chunkFailure(round, parsed.warning ?? `${parsed.dropped} 个片段被校验丢弃`)
      );
      logWarn("LLM 连续对话响应有片段被丢弃", chunkFailure(round, parsed.warning ?? ""));
    }

    // 整表替换：模型可以改起止、改类型、删掉之前误判的片段。
    // 最后一轮已读到视频末尾，仍 open 的片段按已读边界定稿。
    const transformed = deps.transformTable
      ? deps.transformTable(parsed.segments, round)
      : parsed.segments;
    segments = round.isLast ? finalizeTable(transformed) : transformed;
    messages.push(user, assistantTableMessage(segments));
    done += 1;
    deps.onPartial?.({
      segments,
      done,
      total: pending.length,
      durationSec: deps.durationSec,
      mode: deps.mode
    });
    deps.onProgress?.(done, pending.length);
    cursor += 1;
  }

  return {
    segments: [...segments],
    failedChunks,
    droppedChunks,
    authFailed,
    cancelled: cancelled || isAborted(deps),
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    failures
  };
}

/** 终局警告：取消、认证失败、分块失败、片段丢弃与中断，五类事实只在这里组装。 */
export function conversationWarnings(batch: ConversationBatch): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = [];
  if (batch.cancelled) {
    warnings.push({ code: "partial", message: "分析已取消，结果可能不完整" });
  }
  if (batch.authFailed) {
    warnings.push({ code: "llm_failed", message: "LLM 认证失败，请检查 Key" });
  } else {
    if (batch.failedChunks > 0) {
      const reason = batch.failures[0] ? `（${batch.failures[0]}）` : "";
      warnings.push({
        code: "partial",
        message: `${batch.failedChunks} 个分块分析失败${reason}`
      });
    }
    if (batch.stoppedAt !== undefined && !batch.cancelled) {
      warnings.push({
        code: "partial",
        message: `连续对话在第 ${batch.stoppedAt + 1} 段中断，后续内容未读取，结果不完整`
      });
    }
  }
  if (batch.droppedChunks > 0) {
    const reason = batch.failures[0] ? `（${batch.failures[0]}）` : "";
    warnings.push({
      code: "partial",
      message: `${batch.droppedChunks} 个分块的部分片段未通过校验被丢弃${reason}`
    });
  }
  return warnings;
}
