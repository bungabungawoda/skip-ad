import type { Segment } from "../plugin/types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clampInterval(
  start: number,
  end: number,
  duration: number
): [number, number] | null {
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || !isFiniteNumber(duration)) {
    return null;
  }
  if (duration <= 0) return null;
  const lo = clamp(start, 0, duration);
  const hi = clamp(end, 0, duration);
  if (hi - lo <= 0) return null;
  return [lo, hi];
}

export function mergeIntervals(
  intervals: Array<[number, number]>,
  maxGap = 1.5
): Array<[number, number]> {
  const sorted = intervals
    .filter(([start, end]) => isFiniteNumber(start) && isFiniteNumber(end) && end > start)
    .map(([start, end]) => [start, end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] <= maxGap) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function totalCoverage(segments: Segment[], duration: number): number {
  if (!isFiniteNumber(duration) || duration <= 0) return 0;
  const intervals = segments.map((segment) => [segment.start, segment.end] as [number, number]);
  const merged = mergeIntervals(intervals, 0);
  const covered = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  return clamp(covered / duration, 0, 1);
}

export function formatClock(seconds: number): string {
  if (!isFiniteNumber(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  // 超过一小时的视频写成 1:30:00，模型和用户都不用自己把 90:00 换算成小时。
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

