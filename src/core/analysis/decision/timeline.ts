/**
 * 时间轴怎么变成提示词里的正文。
 *
 * 台词和辅助证据分两节：台词带起止时间，模型靠它定位边界；弹幕只有时间点，
 * 是观众的行为痕迹。混在一节里，模型会把弹幕当成台词，把「广告」两个字
 * 当成正文内容。
 */

import { formatClock } from "../../lib/time";
import type { TimeRange } from "./windows";
import type { TimelineLine } from "./types";

export interface TimedText {
  start: number;
  end: number;
  text: string;
}

/** 字幕行变成台词行：丢掉时间无效或正文为空的行。 */
export function cuesToTimelineLines(cues: TimedText[]): TimelineLine[] {
  return cues
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .map((cue) => ({ start: cue.start, end: cue.end, text: cue.text.trim(), kind: "cue" as const }))
    .filter((line) => line.text.length > 0);
}

export function linesInRange(lines: TimelineLine[], range: TimeRange): TimelineLine[] {
  return lines.filter((line) => line.end > range.start && line.start < range.end);
}

/** 区间内第一条台词与最后一条台词；用于把格子吸附到句子边界。 */
export function cuesInRange(lines: TimelineLine[], range: TimeRange): TimelineLine[] {
  return lines.filter(
    (line) => (line.kind ?? "cue") === "cue" && line.end > range.start && line.start < range.end
  );
}

function formatCue(line: TimelineLine): string {
  return `${formatClock(line.start)}-${formatClock(line.end)} ${line.text}`;
}

function formatNote(line: TimelineLine): string {
  return `${formatClock(line.start)} ${line.text}`;
}

/**
 * 把区间内的行排成两节。没有台词时省掉那一节，不要留一个空标题，
 * 否则模型会以为「台词被裁掉了」而不是「这个视频没有台词」。
 */
export function formatTimeline(lines: TimelineLine[]): string {
  const cues = lines.filter((line) => (line.kind ?? "cue") === "cue").sort((a, b) => a.start - b.start);
  const notes = lines.filter((line) => line.kind === "note").sort((a, b) => a.start - b.start);
  const sections: string[] = [];
  if (cues.length > 0) {
    sections.push(`【台词】每行开头是这句台词的起止时间。\n${cues.map(formatCue).join("\n")}`);
  }
  if (notes.length > 0) {
    sections.push(`【弹幕样本】每行开头是这一桶弹幕的时间，样本是裁剪过的。\n${notes.map(formatNote).join("\n")}`);
  }
  return sections.join("\n\n");
}
