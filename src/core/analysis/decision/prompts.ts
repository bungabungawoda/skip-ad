/**
 * 提示词文本。
 *
 * 两条硬规则：
 * - 判定标准放共享输入，不在每个问题里重复。实测 10 个窗口重复判据要 2360 token，
 *   放共享输入只要 1491 token，而且概率更干净。
 * - 结尾的定义必须写死成「最后一句说完、正片重新开始的那一刻」。少这句，模型会把
 *   结尾定在广告最后一句的起点，早一整格。
 */

import { formatClock } from "../../lib/time";
import type { SegmentKind } from "../../plugin/types";
import type { TimeRange } from "./windows";
import type { TimelineLine } from "./types";

/** 共享输入的开头：判定标准 + 读法说明。 */
export function buildInputPreamble(rubric: string, notes: string[] = []): string {
  const parts = [`【判定标准】${rubric}`];
  if (notes.length > 0) parts.push(`【读法】${notes.join(" ")}`);
  return parts.join("\n");
}

/** 粗扫：5 分钟一格。只问有没有出现，不问占多少。 */
export function scanQuestion(range: TimeRange): string {
  return `${formatClock(range.start)} 到 ${formatClock(range.end)} 这段时间里有没有出现付费广告？`;
}

/** 细扫：30 秒一格。 */
export function fineQuestion(range: TimeRange): string {
  return `${formatClock(range.start)} 到 ${formatClock(range.end)} 这 ${Math.round(range.end - range.start)} 秒里有没有出现付费广告？`;
}

/**
 * 逐句问：这一句是不是广告的一部分。
 * 比「起点落在哪一格」可靠：模型判语义很准，做时间换算不准（实测逐句问的
 * 前后句分离度是 0.045 / 0.055，而 2.5 秒一格的选择题会偏 1 到 3 格）。
 */
export function cueIsAdQuestion(line: TimelineLine): string {
  return `${formatClock(line.start)} 到 ${formatClock(line.end)} 这一句（${line.text}）是不是品牌付费广告的一部分？`;
}

export function verifyWholeQuestion(range: TimeRange): string {
  return `从 ${formatClock(range.start)} 到 ${formatClock(range.end)} 这一段，是不是整段都属于付费广告？`;
}

export function verifyNeighborQuestion(line: TimelineLine, side: "prev" | "next"): string {
  const where = side === "prev" ? "紧挨在广告前面" : "紧挨在广告后面";
  return `${formatClock(line.start)} 到 ${formatClock(line.end)} 这一句（${line.text}）${where}，它是不是也属于这段广告？`;
}

/** 边界四选一：这一秒是广告的起始、中间、结束，还是不属于广告。 */
export function boundaryQuestion(range: TimeRange): string {
  const seconds = Math.max(1, Math.round(range.end - range.start));
  return `${formatClock(range.start)} 到 ${formatClock(range.end)} 这 ${seconds} 秒，是这段广告的起始、中间、结束，还是不属于广告？`;
}

export const BOUNDARY_CRITERIA = {
  start: "这 1 秒是广告的第一秒，广告从这里开始。",
  middle: "这 1 秒在广告中间，前后都还是广告。",
  end: "这 1 秒是广告的最后一秒，广告到这里结束。",
  none: "这 1 秒不属于广告。"
} as const;

export const KIND_QUESTION = "这段推广属于哪一类？";

export const KIND_CRITERIA: Record<SegmentKind, string> = {
  sponsor: "商单口播，有明确的赞助商说明。",
  insert: "中插植入，正片中途插进来的一段推广。",
  promo: "带货行动号召，引导去购买或领券。",
  self_promo: "求三连、关注、充电、粉丝群等自我推广。",
  topic: "正常内容，讲产品但属于评测、科普或剧情。",
  unknown: "以上都不像。"
};
