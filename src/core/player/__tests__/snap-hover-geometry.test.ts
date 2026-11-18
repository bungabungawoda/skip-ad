import { describe, expect, it } from "vitest";
import type { ProgressMark } from "../progress-mark-geometry";
import {
  findHoverMark,
  insideRect,
  keepAliveAt,
  percentAt,
  pillLeftStyle,
  playheadPercent,
  ringShadow,
  withAlpha,
  type SnapRect
} from "../snap-hover-geometry";

function rect(overrides: Partial<SnapRect> = {}): SnapRect {
  return { left: 0, right: 1000, top: 0, bottom: 20, width: 1000, ...overrides };
}

function mark(overrides: Partial<ProgressMark> = {}): ProgressMark {
  return {
    key: "10.00-20.00",
    kind: "sponsor",
    label: "赞助",
    left: 40,
    width: 20,
    end: 20,
    color: "#f2636a",
    ...overrides
  };
}

function video(duration: number, currentTime: number): HTMLVideoElement {
  return { duration, currentTime } as HTMLVideoElement;
}

describe("悬停位置的换算", () => {
  it("指针横坐标按轨道矩形换算成百分比，并钳制在 0 到 100", () => {
    expect(percentAt(500, rect())).toBe(50);
    expect(percentAt(600, rect({ left: 100, right: 1100 }))).toBe(50);
    expect(percentAt(2000, rect())).toBe(100);
    expect(percentAt(-10, rect())).toBe(0);
  });

  it("轨道不存在或宽度为零时没有百分比", () => {
    expect(percentAt(500, null)).toBeNull();
    expect(percentAt(500, rect({ width: 0 }))).toBeNull();
  });

  it("播放位置按当前时间与时长换算，时长没就绪时按 0", () => {
    expect(playheadPercent(video(200, 50))).toBe(25);
    expect(playheadPercent(video(Number.NaN, 50))).toBe(0);
    expect(playheadPercent(null)).toBe(0);
  });
});

describe("命中色块与胶囊保留区", () => {
  it("按 6 像素容差命中色块，容差外不命中", () => {
    expect(findHoverMark([mark()], 500, rect())?.key).toBe("10.00-20.00");
    // 60.4% 离色块结尾 4 像素，仍在 6 像素容差内。
    expect(findHoverMark([mark()], 604, rect())?.key).toBe("10.00-20.00");
    // 60.7% 离结尾 7 像素，超出容差。
    expect(findHoverMark([mark()], 607, rect())).toBeNull();
  });

  it("色块外 6 像素以上不命中，没有轨道时不命中", () => {
    expect(findHoverMark([mark()], 100, rect())).toBeNull();
    expect(findHoverMark([mark()], 700, rect())).toBeNull();
    expect(findHoverMark([mark()], 500, null)).toBeNull();
  });

  it("多个色块里只命中指针所在的那一段", () => {
    const marks = [mark({ key: "a", left: 10, width: 10 }), mark({ key: "b", left: 40, width: 20 })];
    expect(findHoverMark(marks, 403, rect())?.key).toBe("b");
    expect(findHoverMark(marks, 150, rect())?.key).toBe("a");
  });

  it("指针在进度条、胶囊或两者之间的竖直通道里都算还在路上", () => {
    const bar = rect();
    const pill = rect({ left: 400, right: 600, top: -40, bottom: -12, width: 200 });
    expect(insideRect(bar, 500, 10)).toBe(true);
    expect(keepAliveAt(bar, pill, 500, 10)).toBe(true);
    expect(keepAliveAt(bar, pill, 500, -30)).toBe(true);
    expect(keepAliveAt(bar, pill, 500, -5)).toBe(true);
    // 离开胶囊横向范围的通道不算「还在路上」。
    expect(keepAliveAt(bar, pill, 500, -20)).toBe(true);
    expect(keepAliveAt(bar, pill, 900, -20)).toBe(false);
  });
});

describe("颜色与样式", () => {
  it("六位色值转成带透明度的 rgba", () => {
    expect(withAlpha("#f2636a", 0.18)).toBe("rgba(242, 99, 106, 0.18)");
    expect(withAlpha("rgb(1,2,3)", 0.5)).toBe("rgba(244, 244, 245, 0.5)");
  });

  it("胶囊位置两端对称钳制，预览环光晕带片段颜色", () => {
    // 两端余量相等：胶囊贴边时不会被进度条边缘裁掉。
    expect(pillLeftStyle(60)).toContain("clamp(");
    expect(pillLeftStyle(60)).toContain("calc(100% - 40px)");
    const shadow = ringShadow("#f2636a");
    expect(shadow).toContain("rgba(242, 99, 106, 0.18)");
    expect(shadow).toContain("rgba(242, 99, 106, 0.45)");
  });
});
