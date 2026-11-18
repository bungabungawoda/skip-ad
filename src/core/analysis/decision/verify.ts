/**
 * 复核：定位出来的边界可能差一句。
 *
 * 三个问题一次问完：整段是不是广告、前一句是不是也算、后一句是不是也算。
 * 实测整段 0.982、前一句 0.045、后一句 0.055、对照内容段 0.010，
 * 这三个问题的区分度足够拿来做边界校验。
 */

import type { SegmentKind } from "../../plugin/types";
import type { TimelineLine } from "./types";
import type { TimeRange } from "./windows";

interface Neighbors {
  prev?: TimelineLine;
  next?: TimelineLine;
}

/** 紧挨在片段前后的两句台词。中间隔着一句没读到的台词时不算邻居。 */
export function findNeighbors(lines: TimelineLine[], range: TimeRange): Neighbors {
  const cues = lines
    .filter((line) => (line.kind ?? "cue") === "cue")
    .sort((a, b) => a.start - b.start);
  let prev: TimelineLine | undefined;
  let next: TimelineLine | undefined;
  for (const cue of cues) {
    if (cue.end <= range.start + 0.01) prev = cue;
    if (!next && cue.start >= range.end - 0.01) next = cue;
  }
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}

export interface VerifyAnswers {
  /** 整段是不是广告的概率。 */
  whole: number;
  prev?: number;
  next?: number;
  kind?: SegmentKind;
}

interface VerifyOutcome {
  range: TimeRange;
  confidence: number;
  kind: SegmentKind;
  extended: boolean;
}

interface ApplyVerifyInput {
  segment: TimeRange;
  neighbors: Neighbors;
  answers: VerifyAnswers;
  /** 定位阶段给出的置信度（细扫概率）。 */
  baseConfidence: number;
  /** 低于这个概率就把置信度压到整段概率上（降级成只标记）。 */
  wholeThreshold: number;
  /** 高于这个概率就向那一侧扩一句。 */
  neighborThreshold: number;
}

/**
 * 整段概率低于 0.5 说明窗口没套住广告。这时如果紧挨着的前后句有高分，
 * 把窗口平移到那一句再复核，不能直接丢掉——高分邻居本身就是强信号。
 * 两边都没有高分才视为判错，返回 undefined 让调用方丢弃这段。
 * 0.5 到阈值之间保留，但置信度被压低，策略层会把它降成只标记。
 */
export function applyVerify(input: ApplyVerifyInput): VerifyOutcome | undefined {
  const { segment, neighbors, answers, baseConfidence, wholeThreshold, neighborThreshold } = input;
  if (answers.whole < 0.5) {
    const length = Math.max(1, segment.end - segment.start);
    if (neighbors.next && (answers.next ?? 0) > neighborThreshold) {
      return {
        // 用原窗口长度向外带一段：只挪到邻句会再次把广告截短，
        // 带出一个与原窗口同量级的范围，下一轮整段复核才有机会覆盖完整广告。
        range: {
          start: neighbors.next.start,
          end: Math.max(segment.end, neighbors.next.end + length)
        },
        confidence: Math.min(baseConfidence, answers.next ?? 0),
        kind: answers.kind ?? "unknown",
        extended: true
      };
    }
    if (neighbors.prev && (answers.prev ?? 0) > neighborThreshold) {
      return {
        range: {
          start: Math.min(segment.start, neighbors.prev.start - length),
          end: neighbors.prev.end
        },
        confidence: Math.min(baseConfidence, answers.prev ?? 0),
        kind: answers.kind ?? "unknown",
        extended: true
      };
    }
    return undefined;
  }

  let start = segment.start;
  let end = segment.end;
  let extended = false;
  if (neighbors.prev && (answers.prev ?? 0) > neighborThreshold) {
    start = Math.min(start, neighbors.prev.start);
    extended = true;
  }
  if (neighbors.next && (answers.next ?? 0) > neighborThreshold) {
    end = Math.max(end, neighbors.next.end);
    extended = true;
  }

  const confidence =
    answers.whole < wholeThreshold ? Math.min(baseConfidence, answers.whole) : baseConfidence;
  return {
    range: { start, end },
    confidence,
    kind: answers.kind ?? "unknown",
    extended
  };
}
