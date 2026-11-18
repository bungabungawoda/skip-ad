/**
 * 连续对话的共享协议层（一个视频 = 一个对话），两个站点共用。
 *
 * 如果每块各自问一次再拼结果，块边界就会变成「广告能结束的最晚时间」：
 * 跨边界的广告被截成两条冲突区间，程序只能二选一。
 * 这里按顺序、不重叠地送内容，模型每轮返回「到此为止的完整片段表」，
 * 可以修订、合并、删除之前给出的片段。表里只有一份几何，冲突从源头消失。
 *
 * chat/completions 是无状态接口：连续性只能由客户端重发 messages 历史实现。
 * 每轮写回历史的 assistant 消息是规范化后的紧凑片段表，而不是模型原文
 * （MiniMax-M3 会把 <think> 塞进 content），既省 token 也不会把示例 JSON 带回上下文。
 */
import type { LlmMessage } from "../ports/llm/types";
import type { Segment } from "../plugin/types";

/** 一轮模型响应解析出来的整表。调用方必须用 segments 整表替换上一轮的表。 */
export interface RoundTable {
  segments: Segment[];
  dropped: number;
  /** 本轮完全不可用：保留上一轮的表并中断对话。 */
  error?: string;
  /** 有片段被校验丢弃：表还能用，但结果不完整，不能写缓存。 */
  warning?: string;
}

/**
 * 片段表的规范形状：写回对话历史与「上一轮片段表」都用同一份紧凑 JSON。
 * 不带 families（程序侧算的证据族，模型不需要复述），也不带模型正文里的 think 块。
 */
function formatSegmentTable(segments: Segment[]): string {
  return JSON.stringify({
    segments: segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      status: segment.status ?? "closed",
      kind: segment.kind,
      confidence: segment.confidence,
      evidence: segment.evidence,
      reason: segment.reason
    }))
  });
}

/** 把本轮定稿的整表写回历史，作为下一轮 assistant 上下文。 */
export function assistantTableMessage(segments: Segment[]): LlmMessage {
  return { role: "assistant", content: formatSegmentTable(segments) };
}

/**
 * chat/completions 无状态，连续性靠每轮重发全历史，但整包证据会随轮数
 * O(n²) 增长。压缩策略：最近 keepRounds 轮保留完整证据，更早的轮次把
 * 整包证据替换成一行摘要——片段表本身在 assistant 消息里本来就保留，
 * 所以跨轮修订能力不受影响。
 *
 * 注意：改写历史会掐断服务商的前缀缓存（前缀在第 1 条被改写的消息处分叉）。
 * 有自动前缀缓存的服务商不要调用它，保留完整历史更省钱；没有的才压缩。
 */
const compactRoundNote = (roundIndex: number, total: number): LlmMessage => ({
  role: "user",
  content: `第 ${roundIndex + 1} / ${total} 段已读完（证据略，以免上下文随轮数无限增长）；该段之后你给出的完整片段表见对话历史。`
});

/** 传进来的 history 只包含已完成问答对（system + 成对 user/assistant），不含本轮待发送的 user。 */
export function compactHistory(
  history: LlmMessage[],
  totalRounds: number,
  keepRounds: number = COMPACT_KEEP_ROUNDS
): LlmMessage[] {
  if (totalRounds <= keepRounds) return history;
  const pairs = (history.length - 1) / 2;
  if (pairs <= keepRounds) return history;
  const messages: LlmMessage[] = [history[0] as LlmMessage];
  for (let pair = 0; pair < pairs; pair += 1) {
    if (pair < pairs - keepRounds) {
      messages.push(compactRoundNote(pair, totalRounds));
    } else {
      messages.push(history[1 + pair * 2] as LlmMessage);
    }
    messages.push(history[2 + pair * 2] as LlmMessage);
  }
  return messages;
}

/** 最近这几轮保留完整证据包；更早的轮次只留一行摘要。 */
const COMPACT_KEEP_ROUNDS = 2;

/** 最后一轮定稿：已读到视频末尾，把仍 open 的片段按已读边界定稿成 closed。 */
export function finalizeTable(segments: Segment[]): Segment[] {
  return segments.map((segment) =>
    segment.status === "open" ? { ...segment, status: "closed" } : segment
  );
}

/**
 * 一轮解析的收尾：决定空表是「本轮没有可用的片段」还是正常的跨块产物，
 * 并把丢弃数转成警告。两个站点解析器（B 站秒数制、字幕行 ID 制）共用这条规则，
 * 各自只负责几何约束。
 *
 * 一条都没通过校验时不能拿空表覆盖上一轮结果：那等于用坏响应删掉已知片段。
 * submitted 不含跨块延后的片段：起点落在已读边界是正常产物，下一轮会重新给出，
 * 一次边界猜测不该让整条视频不写缓存、每次刷新都重跑对话。
 */
export function settleRoundTable(input: {
  /** 模型本轮提交的片段数，不含跨块延后到下一轮的。 */
  submitted: number;
  /** 通过校验的片段，已按站点规则去重合并。 */
  segments: Segment[];
  /** 被校验丢弃的片段数。 */
  dropped: number;
}): RoundTable {
  if (input.submitted > 0 && input.segments.length === 0) {
    return {
      segments: [],
      dropped: input.dropped,
      error: input.dropped > 0 ? `${input.dropped} 个片段全部被校验丢弃` : "本轮没有可用的片段"
    };
  }
  const result: RoundTable = { segments: input.segments, dropped: input.dropped };
  if (input.dropped > 0) result.warning = `${input.dropped} 个片段被校验丢弃`;
  return result;
}
