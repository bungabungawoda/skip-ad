import type { Segment, SegmentKind } from "../plugin/types";
import type { SegmentPolicy } from "../analysis/types";
import { segmentKey } from "./segment-skipper";
import { segmentBarColor } from "../ui/segment-colors";
import { kindLabel } from "../policy/kinds";

/** 进度条上的一段色块，位置已换算成轨道宽度的百分比。 */
export interface ProgressMark {
  key: string;
  kind: SegmentKind;
  /** 类型中文名，胶囊 aria-label 用。 */
  label: string;
  /** 左边界，0–100。 */
  left: number;
  /** 宽度，0–100；最小 2px 由 CSS min-width 兜底。 */
  width: number;
  /** 片段结尾的秒数，胶囊文案与吸附用。 */
  end: number;
  color: string;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 片段视图换算成百分比色块。策略关闭、时长无效、空区间都不画。 */
export function buildProgressMarks(
  views: Array<{ segment: Segment; policy: SegmentPolicy; key?: string }>,
  duration: number,
  site?: string | null
): ProgressMark[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const marks: ProgressMark[] = [];
  for (const view of views) {
    if (view.policy === "off") continue;
    const left = clampPercent((Math.max(0, view.segment.start) / duration) * 100);
    const right = clampPercent((Math.min(duration, view.segment.end) / duration) * 100);
    if (right <= left) continue;
    marks.push({
      key: view.key ?? segmentKey(view.segment),
      kind: view.segment.kind,
      label: kindLabel(view.segment.kind),
      left,
      width: right - left,
      end: Math.min(duration, Math.max(0, view.segment.end)),
      color: segmentBarColor(view.segment.kind, site)
    });
  }
  return marks;
}

/** 找出百分比位置命中的片段；容差按百分比传入，多个命中时取最近的。 */
export function findMarkAt(
  marks: ProgressMark[],
  percent: number,
  tolerancePercent: number
): ProgressMark | null {
  let best: ProgressMark | null = null;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const start = mark.left;
    const end = mark.left + mark.width;
    if (percent < start - tolerancePercent || percent > end + tolerancePercent) continue;
    const distance = percent < start ? start - percent : percent > end ? percent - end : 0;
    if (distance < bestDistance) {
      best = mark;
      bestDistance = distance;
    }
  }
  return best;
}

/** 找出距离百分比位置最近、且在容差内的片段结尾。 */
export function nearestMarkEnd(
  marks: ProgressMark[],
  percent: number,
  tolerancePercent: number
): ProgressMark | null {
  let best: ProgressMark | null = null;
  let bestDistance = Infinity;
  for (const mark of marks) {
    const distance = Math.abs(mark.left + mark.width - percent);
    if (distance <= tolerancePercent && distance < bestDistance) {
      best = mark;
      bestDistance = distance;
    }
  }
  return best;
}
