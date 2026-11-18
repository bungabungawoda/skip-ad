import { describe, expect, it } from "vitest";
import { buildWindows, expandRange, groupWindowsByBlock, mergeHitWindows } from "../windows";

describe("扫描窗口", () => {
  it("按步长铺窗口，相邻窗口重叠", () => {
    const windows = buildWindows(
      { start: 0, end: 600 },
      { windowSeconds: 300, strideSeconds: 270 }
    );
    expect(windows.map((window) => [window.start, window.end])).toEqual([
      [0, 300],
      [270, 570],
      [540, 600]
    ]);
  });

  it("步长大于窗口时按窗口长度走，避免出现空洞", () => {
    const windows = buildWindows(
      { start: 0, end: 60 },
      { windowSeconds: 30, strideSeconds: 120 }
    );
    expect(windows.map((window) => [window.start, window.end])).toEqual([
      [0, 30],
      [30, 60]
    ]);
  });

  it("时长为零或负数时不给窗口", () => {
    expect(buildWindows({ start: 0, end: 0 }, { windowSeconds: 30, strideSeconds: 15 })).toEqual([]);
  });
});

describe("命中窗口合并", () => {
  const windows = buildWindows(
    { start: 0, end: 600 },
    { windowSeconds: 300, strideSeconds: 270 }
  );

  it("允许中间夹一个低分窗口", () => {
    const merged = mergeHitWindows(windows, [0.9, 0.1, 0.8], {
      threshold: 0.5,
      maxIndexGap: 2
    });
    expect(merged).toEqual([{ start: 0, end: 600 }]);
  });

  it("夹空超过一格就断开成两段", () => {
    const merged = mergeHitWindows(windows, [0.9, 0.1, 0.8], {
      threshold: 0.5,
      maxIndexGap: 1
    });
    expect(merged).toEqual([
      { start: 0, end: 300 },
      { start: 540, end: 600 }
    ]);
  });

  it("全低分时没有候选段", () => {
    expect(
      mergeHitWindows(windows, [0.1, 0.2, 0.3], { threshold: 0.5, maxIndexGap: 2 })
    ).toEqual([]);
  });
});

describe("区间扩展", () => {
  it("向两侧扩并裁到视频范围", () => {
    expect(expandRange({ start: 10, end: 20 }, 30, 100)).toEqual({ start: 0, end: 50 });
    expect(expandRange({ start: 90, end: 95 }, 30, 100)).toEqual({ start: 60, end: 100 });
  });
});

describe("按块分组", () => {
  it("每块的跨度不超过上限，窗口不重不漏", () => {
    const windows = buildWindows(
      { start: 0, end: 1800 },
      { windowSeconds: 300, strideSeconds: 270 }
    );
    const blocks = groupWindowsByBlock(windows, 600);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.range.end - block.range.start).toBeLessThanOrEqual(600 + 300);
    }
    const covered = blocks.flatMap((block) => block.windows.map((window) => window.index));
    expect(covered).toEqual(windows.map((window) => window.index));
    // 相邻两块在时间上首尾相接，中间没有空洞。
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1];
      const current = blocks[index];
      expect(current?.range.start).toBeLessThanOrEqual(previous?.range.end ?? 0);
    }
  });
});
