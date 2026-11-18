/**
 * 扫描窗口与命中合并。
 *
 * 窗口是一段固定长度的时间片，相邻窗口按步长重叠。合并只认窗口下标：
 * 时间上重叠的窗口天然首尾相接，用下标差判断「中间夹了几个低分窗口」更直接，
 * 也不会被步长和窗口长度的组合绕晕。
 */

import { clamp } from "../../lib/time";

export interface TimeRange {
  start: number;
  end: number;
}

export interface ScanWindow extends TimeRange {
  index: number;
}

interface WindowOptions {
  windowSeconds: number;
  strideSeconds: number;
}

/** 在 [from, to] 上铺窗口。窗口首尾可以超出区间，但会被裁到区间内。 */
export function buildWindows(range: TimeRange, options: WindowOptions): ScanWindow[] {
  const { windowSeconds, strideSeconds } = options;
  const from = Math.max(0, range.start);
  const to = Math.max(from, range.end);
  if (to - from <= 0) return [];
  const window = Math.max(1, windowSeconds);
  const stride = Math.max(1, Math.min(strideSeconds, window));
  const windows: ScanWindow[] = [];
  let index = 0;
  for (let start = from; start < to; start += stride) {
    const end = Math.min(to, start + window);
    windows.push({ index, start, end });
    index += 1;
    if (end >= to) break;
  }
  return windows;
}

/**
 * 把命中的窗口并成候选段。下标差不超过 maxIndexGap 就继续同一段：
 * maxIndexGap 为 1 时相邻窗口必须紧挨着，为 2 时允许中间空一个。
 */
export function mergeHitWindows(
  windows: ScanWindow[],
  probabilities: number[],
  options: { threshold: number; maxIndexGap: number }
): TimeRange[] {
  const { threshold, maxIndexGap } = options;
  const merged: TimeRange[] = [];
  let current: TimeRange | undefined;
  let lastHitIndex: number | undefined;
  for (const window of windows) {
    const probability = probabilities[window.index] ?? 0;
    if (probability < threshold) continue;
    if (current && lastHitIndex !== undefined && window.index - lastHitIndex <= maxIndexGap) {
      current.end = Math.max(current.end, window.end);
    } else {
      current = { start: window.start, end: window.end };
      merged.push(current);
    }
    lastHitIndex = window.index;
  }
  return merged;
}

/** 向两侧扩一段，扩完裁到 [0, duration]。 */
export function expandRange(range: TimeRange, seconds: number, duration: number): TimeRange {
  return {
    start: clamp(range.start - seconds, 0, duration),
    end: clamp(range.end + seconds, 0, duration)
  };
}

/**
 * 把全局窗口按块分组：一块一次请求，块与块不重叠。
 * 块的时间范围取它包含的窗口的并集，保证每个窗口的台词都在同一份输入里。
 */
export function groupWindowsByBlock(
  windows: ScanWindow[],
  blockSeconds: number
): Array<{ range: TimeRange; windows: ScanWindow[] }> {
  const blocks: Array<{ range: TimeRange; windows: ScanWindow[] }> = [];
  let current: ScanWindow[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) blocks.push({ range: { start: first.start, end: last.end }, windows: current });
    current = [];
  };
  for (const window of windows) {
    const first = current[0];
    if (first && window.end - first.start > blockSeconds) flush();
    current.push(window);
  }
  flush();
  return blocks;
}
