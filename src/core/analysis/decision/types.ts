/**
 * 决策模型判广告的类型契约。
 *
 * 和连续对话流程的区别：模型不给时间，只给概率。时间轴由这里的代码持有，
 * 所以输入是「一条时间轴 + 一份判定标准」，输出是本地算出来的片段。
 */

import type { Segment } from "../../plugin/types";
import type { AnalysisWarning } from "../types";

/**
 * 时间轴上的一行。
 * cue 是台词，带起止时间；note 是辅助证据（弹幕桶、章节标题），只有时间点。
 * 两种行在提示词里分节出现，模型知道弹幕不是台词。
 */
export interface TimelineLine {
  start: number;
  end: number;
  text: string;
  kind?: "cue" | "note";
}

export interface DecisionAnalysisResult {
  segments: Segment[];
  warnings: AnalysisWarning[];
}

export interface DecisionAnalysisInput {
  /** 正片时长；未知或为 0 时不分析。 */
  duration: number;
  lines: TimelineLine[];
  /** 站点提供的判定标准，放在共享输入的第一节，每个问题不再重复。 */
  rubric: string;
  /** 额外的读法说明，例如「弹幕是裁剪后的样本」。 */
  notes?: string[];
}
