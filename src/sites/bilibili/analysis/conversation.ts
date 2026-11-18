/**
 * B 站连续对话的站点层：system 提示词组装与秒数制整表解析。
 * 共享的整表写回、历史压缩与定稿逻辑在 core/analysis/conversation。
 */
import type { LlmMessage } from "../../../core/ports/llm/types";
import type { Segment, SegmentKind } from "../../../core/plugin/types";
import {
  extractJson,
  mergeAdjacentSegments,
  normalizeSegmentTable,
  readSegmentsArray
} from "../../../core/analysis/normalize";
import {
  settleRoundTable,
  type RoundTable
} from "../../../core/analysis/conversation";
import { buildConversationSystemPrompt, type ConversationVideoInfo } from "./prompt";
import { MIN_SEGMENT_SECONDS } from "../../../core/lib/limits";

export type { RoundTable };

const EPSILON = 0.01;

/** 对话的第 0 条消息，整个视频只发一次。视频信息拼进 system 尾部。 */
export function createConversationSystem(
  overrides?: Partial<Record<SegmentKind, string>>,
  video?: ConversationVideoInfo
): LlmMessage {
  return buildConversationSystemPrompt(overrides, video);
}

/**
 * 解析一轮响应，并按「已读到哪里」约束几何：
 * - start 越过已读边界 = 模型在猜没读过的内容，丢弃；
 * - open 片段的 end 一律钉在已读边界（这就是 open 的定义），不会出现一个
 *   更短的临时终点被当成自动跳的落点；
 * - 声称 closed 却越过已读边界，降级成 open，避免采信没读过的结尾。
 */
export function parseRoundTable(
  text: string,
  duration: number,
  readUpTo: number
): RoundTable {
  const raw = extractJson(text);
  if (raw === null) return { segments: [], dropped: 0, error: "no json object found" };
  if (readSegmentsArray(raw) === null) {
    return { segments: [], dropped: 0, error: "missing segments array" };
  }

  // 一次归一化、一次读取：先取校验结果，掉了 N 条时要检查原条的存活面。
  const accepted = normalizeSegmentTable(raw, duration);
  if (accepted.error) {
    return { segments: [], dropped: accepted.dropped, error: accepted.error };
  }
  let dropped = accepted.dropped;
  const segments: Segment[] = [];
  /** 起点落在已读边界、留到下一轮再给的片段；不是坏响应。 */
  let boundarySkipped = 0;

  for (const segment of accepted.segments) {
    // 起点落在已读边界上：这一段的内容还没读到，下一轮会重新给出。
    // 不能计入丢弃——一次边界猜测就让整条视频不写缓存，每次刷新都重跑对话。
    if (segment.start >= readUpTo - EPSILON) {
      if (segment.start > readUpTo + EPSILON) dropped += 1;
      else boundarySkipped += 1;
      continue;
    }
    const mustClamp =
      segment.status === "open" || segment.end > readUpTo + EPSILON;
    if (!mustClamp) {
      segments.push(segment);
      continue;
    }
    const end = Number(readUpTo.toFixed(2));
    if (end - segment.start < MIN_SEGMENT_SECONDS) {
      dropped += 1;
      continue;
    }
    // open 或越界的 closed 都不能定稿：保留 status=open，策略层永不自动跳。
    segments.push({ ...segment, end, status: "open" });
  }

  // 裁剪之后再合并：跨块广告在第 N 轮被钉在边界、第 N+1 轮接上时，
  // 两段会首尾相接，这里合成一段，避免跳过一段后停在下一段中间。
  const merged = mergeAdjacentSegments(segments);
  // 提交数不含跨块延后：起点落在已读边界是正常产物，不算丢弃也不算坏响应。
  return settleRoundTable({
    submitted: accepted.segments.length - boundarySkipped + accepted.dropped,
    segments: merged,
    dropped
  });
}
