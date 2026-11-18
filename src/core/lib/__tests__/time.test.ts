import { describe, expect, it } from "vitest";
import {
  clampInterval,
  formatClock,
  mergeIntervals,
  totalCoverage
} from "../../lib/time";
import { sponsorSegment as segment } from "../../../../tests/helpers/segments";

describe("time helpers", () => {
  it("formats hours instead of a 90-minute clock", () => {
    expect(formatClock(90)).toBe("01:30");
    expect(formatClock(5_400)).toBe("1:30:00");
    expect(formatClock(3_661)).toBe("1:01:01");
  });

  it("clamps intervals to the video duration", () => {
    expect(clampInterval(-5, 20, 100)).toEqual([0, 20]);
    expect(clampInterval(10, 200, 100)).toEqual([10, 100]);
    expect(clampInterval(20, 10, 100)).toBeNull();
    expect(clampInterval(0, 10, 0)).toBeNull();
    // 0 和 1 之间的时长也是有效时长，不能被当成「时长无效」。
    expect(clampInterval(0, 10, 0.5)).toEqual([0, 0.5]);
    // 非法数值和钳制后变空的区间都返回 null，不能把 NaN 传给下游。
    expect(clampInterval(Number.NaN, 10, 100)).toBeNull();
    expect(clampInterval(0, Number.NaN, 100)).toBeNull();
    expect(clampInterval(0, 10, Number.NaN)).toBeNull();
    expect(clampInterval(5, 5, 100)).toBeNull();
    expect(clampInterval(-5, 0, 100)).toBeNull();
  });

  it("merges overlapping and nearby intervals", () => {
    expect(mergeIntervals([[0, 5], [5.5, 8], [10, 12]])).toEqual([
      [0, 8],
      [10, 12]
    ]);
    // 间隔恰好等于 maxGap 时仍算「相邻」，要合并；再远一点都不合。
    expect(mergeIntervals([[0, 5], [6.5, 8]])).toEqual([[0, 8]]);
    expect(mergeIntervals([[0, 5], [6.6, 8]])).toEqual([[0, 5], [6.6, 8]]);
    // 乱序输入、包含区间、零长区间和非有限值都要处理对。
    expect(mergeIntervals([[2, 3], [0, 10]])).toEqual([[0, 10]]);
    expect(mergeIntervals([[5, 5], [5.5, 8]])).toEqual([[5.5, 8]]);
    expect(mergeIntervals([[5, Number.POSITIVE_INFINITY], [5.5, 8]])).toEqual([[5.5, 8]]);
  });

  it("computes union coverage rather than summing overlaps", () => {
    expect(totalCoverage([segment(0, 10), segment(5, 15)], 20)).toBeCloseTo(0.75);
    expect(totalCoverage([], 20)).toBe(0);
    // 时长非法或为零时返回 0；时长小于覆盖时封顶为 1。
    expect(totalCoverage([segment(0, 10)], 0)).toBe(0);
    expect(totalCoverage([segment(0, 10)], Number.NaN)).toBe(0);
    expect(totalCoverage([segment(0, 10)], 0.5)).toBe(1);
    // 起点不为 0、间隔大于 maxGap=0 都不能多算或少算覆盖。
    expect(totalCoverage([segment(10, 20)], 40)).toBeCloseTo(0.25);
    expect(totalCoverage([segment(0, 10), segment(10.5, 15)], 40)).toBeCloseTo(0.3625);
  });

  it("formats clock values", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65.9)).toBe("01:05");
    expect(formatClock(-1)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });
});
