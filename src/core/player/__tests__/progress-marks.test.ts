// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROGRESS_MARKS_ATTRIBUTE,
  createProgressMarksLayer
} from "../progress-marks";
import {
  buildProgressMarks,
  findMarkAt,
  nearestMarkEnd,
  type ProgressMark
} from "../progress-mark-geometry";
import {
  SNAP_PILL_ATTRIBUTE,
  SNAP_RING_ATTRIBUTE,
  SNAP_UI_ATTRIBUTE
} from "../snap-hover-ui";
import { segment } from "../../../../tests/helpers/segments";

function mark(overrides: Partial<ProgressMark> = {}): ProgressMark {
  return {
    key: "10.00-20.00",
    kind: "sponsor",
    label: "商单",
    left: 10,
    width: 10,
    end: 20,
    color: "#f2636a",
    ...overrides
  };
}

/** 给元素一个固定的几何位置，happy-dom 自己不会算布局。 */
function mockRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({})
    })
  });
}

/** 造一个 1000px 宽的进度条：bar > wrap > track，模拟站点的三层结构。 */
function makeBar(): { bar: HTMLElement; track: HTMLElement } {
  const bar = document.createElement("div");
  const wrap = document.createElement("div");
  const track = document.createElement("div");
  wrap.append(track);
  bar.append(wrap);
  document.body.append(bar);
  mockRect(track, { left: 0, top: 100, width: 1000, height: 4 });
  mockRect(bar, { left: 0, top: 100, width: 1000, height: 4 });
  return { bar, track };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("片段换算成进度条色块", () => {
  it("按总时长换算百分比，策略关闭的不画", () => {
    const marks = buildProgressMarks(
      [
        { segment: segment("sponsor", 10, 20), policy: "auto" },
        { segment: segment("promo", 30, 40), policy: "off" }
      ],
      100
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.left).toBeCloseTo(10);
    expect(marks[0]?.width).toBeCloseTo(10);
    expect(marks[0]?.end).toBe(20);
    expect(marks[0]?.label).toBe("商单");
    expect(marks[0]?.kind).toBe("sponsor");
    expect(marks[0]?.color).toBe("#f2636a");
  });

  it("时长无效时一条都不画", () => {
    const views = [{ segment: segment("sponsor", 1, 2), policy: "auto" as const }];
    expect(buildProgressMarks(views, 0)).toEqual([]);
    expect(buildProgressMarks(views, Number.NaN)).toEqual([]);
  });

  it("越界区间夹到 0–100，空区间和整段在时长外的不画", () => {
    const marks = buildProgressMarks(
      [
        { segment: segment("sponsor", -5, 110), policy: "auto" },
        { segment: segment("insert", 50, 50), policy: "auto" },
        { segment: segment("promo", 120, 130), policy: "auto" }
      ],
      100
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.left).toBe(0);
    expect(marks[0]?.width).toBe(100);
    expect(marks[0]?.end).toBe(100);
  });

  it("每种类型用自己的实心色", () => {
    const marks = buildProgressMarks(
      [
        { segment: segment("insert", 0, 10), policy: "mark" },
        { segment: segment("self_promo", 10, 20), policy: "mark" },
        { segment: segment("unknown", 20, 30), policy: "mark" }
      ],
      100
    );
    expect(marks.map((item) => item.color)).toEqual(["#f09a3e", "#e5b949", "#22d3ee"]);
  });

  it("YouTube 的广告片段用蓝色，话题和未知类型保持原色", () => {
    const views = [
      { segment: segment("sponsor", 0, 10), policy: "auto" as const },
      { segment: segment("insert", 10, 20), policy: "auto" as const },
      { segment: segment("promo", 20, 30), policy: "auto" as const },
      { segment: segment("self_promo", 30, 40), policy: "auto" as const },
      { segment: segment("topic", 40, 50), policy: "auto" as const },
      { segment: segment("unknown", 50, 60), policy: "auto" as const }
    ];
    expect(buildProgressMarks(views, 100, "youtube").map((m) => m.color)).toEqual([
      "#3b82f6",
      "#3b82f6",
      "#3b82f6",
      "#3b82f6",
      "#9a9aa6",
      "#22d3ee"
    ]);
    expect(buildProgressMarks(views, 100, "bilibili").map((m) => m.color)).toEqual([
      "#f2636a",
      "#f09a3e",
      "#5b93f0",
      "#e5b949",
      "#9a9aa6",
      "#22d3ee"
    ]);
  });

  it("重叠裁剪后的视图沿用原始片段键，点击仍能找回原片段", () => {
    const marks = buildProgressMarks(
      [
        {
          segment: segment("sponsor", 80, 100),
          policy: "auto",
          key: "80.00-200.00"
        }
      ],
      200
    );
    expect(marks[0]?.key).toBe("80.00-200.00");
  });
});

describe("命中与吸附的百分比判断", () => {
  const marks = [mark()];

  it("命中色块，容差外不命中", () => {
    expect(findMarkAt(marks, 15, 0)?.key).toBe("10.00-20.00");
    expect(findMarkAt(marks, 9.5, 0)).toBeNull();
    expect(findMarkAt(marks, 9.5, 1)?.key).toBe("10.00-20.00");
  });

  it("吸附只认容差内的片段结尾", () => {
    expect(nearestMarkEnd(marks, 21, 2)?.key).toBe("10.00-20.00");
    expect(nearestMarkEnd(marks, 23, 2)).toBeNull();
    expect(nearestMarkEnd(marks, 10, 2)).toBeNull();
  });
});

describe("原生进度条色块层", () => {
  it("把色块挂进轨道，位置、宽度、颜色写进样式", () => {
    const { bar, track } = makeBar();
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();

    const host = track.querySelector<HTMLElement>(`[${PROGRESS_MARKS_ATTRIBUTE}]`);
    expect(host).not.toBeNull();
    expect(host?.style.pointerEvents).toBe("none");
    // 色块层排在轨道最后，靠 DOM 顺序盖在已播条之上。
    expect(track.lastElementChild).toBe(host);
    expect(host?.style.zIndex).toBe("");

    const block = host?.querySelector<HTMLElement>("[data-skipad-mark]");
    expect(block?.getAttribute("data-skipad-mark")).toBe("10.00-20.00");
    expect(block?.style.left).toBe("10%");
    expect(block?.style.width).toBe("10%");
    expect(block?.style.cssText).toContain("#f2636a");

    // 胶囊挂在进度条本体上，不挂在轨道里，避免被 overflow:hidden 裁掉。
    expect(bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).not.toBeNull();
    expect(track.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).toBeNull();

    layer.dispose();
    expect(track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`)).toBeNull();
    expect(bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).toBeNull();
  });

  it("站点已播条层级更高时，色块层用适配器给的 z-index 抬高", () => {
    const { track } = makeBar();
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getMarks: () => [mark()],
      layerZIndex: 42
    });
    layer.sync();

    const host = track.querySelector<HTMLElement>(`[${PROGRESS_MARKS_ATTRIBUTE}]`);
    expect(host?.style.zIndex).toBe("42");
    layer.dispose();
  });

  it("悬停色块显示预览环和胶囊，点胶囊调用 onSkip", () => {
    const { bar, track } = makeBar();
    const skipped: string[] = [];
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getMarks: () => [mark()],
      onSkip: (key) => skipped.push(key)
    });
    layer.sync();

    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, bubbles: true }));
    const ring = bar.querySelector<HTMLElement>(`[${SNAP_RING_ATTRIBUTE}]`);
    const pill = bar.querySelector<HTMLButtonElement>(`[${SNAP_PILL_ATTRIBUTE}]`);
    expect(ring?.style.opacity).toBe("1");
    expect(ring?.style.left).toBe("20%");
    expect(pill?.style.display).toBe("inline-flex");
    // 胶囊只显示播放图标和时间，不再带「跳到结尾」文字。
    expect(pill?.textContent).toBe("00:20");
    expect(pill?.style.bottom).toBe("18px");
    expect(pill?.getAttribute("aria-label")).toContain("00:20");

    pill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(skipped).toEqual(["10.00-20.00"]);
    layer.dispose();
  });

  it("悬停容差按像素换算，离色块很远时不弹胶囊", () => {
    const { bar, track } = makeBar();
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();

    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 250, bubbles: true }));
    expect(bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`)?.style.display).toBe("none");

    // 距结尾 5px，仍在 6px 容差内。
    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 205, bubbles: true }));
    expect(bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`)?.style.display).toBe(
      "inline-flex"
    );
    layer.dispose();
  });

  it("悬停离开进度条后，过了宽限期才隐藏胶囊", () => {
    vi.useFakeTimers();
    const { bar, track } = makeBar();
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();
    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, bubbles: true }));
    bar.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    // 鼠标往上走去点胶囊的这段时间里，胶囊必须还在。
    expect(bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`)?.style.display).toBe(
      "inline-flex"
    );
    vi.advanceTimersByTime(500);
    expect(bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`)?.style.display).toBe("none");
    expect(bar.querySelector<HTMLElement>(`[${SNAP_RING_ATTRIBUTE}]`)?.style.opacity).toBe("0");
    layer.dispose();
  });

  it("鼠标走进进度条与胶囊之间的通道时，胶囊一直留着", () => {
    vi.useFakeTimers();
    const { bar, track } = makeBar();
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();
    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, bubbles: true }));
    const pill = bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`);
    // 胶囊落在进度条上方 60 像素处，宽 120：横向 140–260，纵向 40–68。
    mockRect(pill as HTMLElement, { left: 140, top: 40, width: 120, height: 28 });

    bar.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    // 往上走，经过胶囊与进度条之间的空白。
    document.body.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 200, clientY: 80, bubbles: true })
    );
    vi.advanceTimersByTime(500);
    expect(pill?.style.display).toBe("inline-flex");

    // 走到别处去，宽限期一过就收。
    document.body.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 700, clientY: 300, bubbles: true })
    );
    vi.advanceTimersByTime(500);
    expect(pill?.style.display).toBe("none");
    layer.dispose();
  });

  it("鼠标在胶囊上移动时，不会按横坐标重新判定而把胶囊关掉", () => {
    const { bar, track } = makeBar();
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();
    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, bubbles: true }));
    const pill = bar.querySelector<HTMLButtonElement>(`[${SNAP_PILL_ATTRIBUTE}]`);
    expect(pill?.style.display).toBe("inline-flex");

    // 胶囊中心在片段结尾（20%），宽度 120，鼠标落在胶囊右半边 24% 处。
    pill?.dispatchEvent(new MouseEvent("pointermove", { clientX: 245, clientY: 50, bubbles: true }));
    expect(pill?.style.display).toBe("inline-flex");
    layer.dispose();
  });

  it("缩略图预览晚一步出现时，胶囊位置不变", () => {
    vi.useFakeTimers();
    const { bar, track } = makeBar();
    const preview = document.createElement("div");
    document.body.append(preview);
    mockRect(preview, { left: 100, top: 100, width: 160, height: 0 });
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => [mark()] });
    layer.sync();
    bar.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, bubbles: true }));
    const pill = bar.querySelector<HTMLElement>(`[${SNAP_PILL_ATTRIBUTE}]`);
    expect(pill?.style.bottom).toBe("18px");

    // 站点缩略图晚一步出现。胶囊固定贴着进度条，不能跟着抬起来。
    mockRect(preview, { left: 100, top: 10, width: 160, height: 90 });
    vi.advanceTimersByTime(500);
    expect(pill?.style.bottom).toBe("18px");
    expect(pill?.style.display).toBe("inline-flex");
    layer.dispose();
  });

  it("拖动松手靠近结尾时补一次跳转，按住 Alt 不跳", async () => {
    const { bar, track } = makeBar();
    const skipped: string[] = [];
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getMarks: () => [mark()],
      onSkip: (key) => skipped.push(key)
    });
    layer.sync();
    const fire = (type: string, clientX: number, altKey = false): boolean =>
      bar.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, altKey }));

    fire("pointerdown", 150);
    fire("pointermove", 205);
    fire("pointerup", 205);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(skipped).toEqual(["10.00-20.00"]);

    skipped.length = 0;
    fire("pointerdown", 150);
    fire("pointermove", 205);
    fire("pointerup", 205, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(skipped).toEqual([]);
    layer.dispose();
  });

  it("拖动落点在中间时不吸附", async () => {
    const { bar, track } = makeBar();
    const skipped: string[] = [];
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getMarks: () => [mark()],
      onSkip: (key) => skipped.push(key)
    });
    layer.sync();
    const fire = (type: string, clientX: number): boolean =>
      bar.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));

    fire("pointerdown", 120);
    fire("pointermove", 150);
    fire("pointerup", 150);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(skipped).toEqual([]);
    layer.dispose();
  });

  it("轨道被站点重建后，色块和胶囊都搬到新进度条", () => {
    const first = makeBar();
    const second = makeBar();
    let current: HTMLElement | null = first.track;
    const layer = createProgressMarksLayer({
      getTrack: () => current,
      getMarks: () => [mark({ key: "1.00-2.00", left: 1, width: 1 })]
    });
    layer.sync();
    expect(first.track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`)).not.toBeNull();
    expect(first.bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).not.toBeNull();

    current = second.track;
    layer.sync();

    expect(first.track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`)).toBeNull();
    expect(first.bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).toBeNull();
    expect(second.track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`)).not.toBeNull();
    expect(second.bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).not.toBeNull();
    layer.dispose();
  });

  it("站点给出胶囊宿主时按它挂载，不按轨道祖先推算", () => {
    const { bar, track } = makeBar();
    const outer = document.createElement("div");
    document.body.append(outer);
    outer.append(bar);
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getSnapHost: () => bar,
      getMarks: () => [mark()]
    });
    layer.sync();

    expect(bar.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)).not.toBeNull();
    expect(outer.querySelector(`:scope > [${SNAP_UI_ATTRIBUTE}]`)).toBeNull();
    layer.dispose();
  });

  it("轨道暂时不存在时不报错，出现后自动补挂", () => {
    let track: HTMLElement | null = null;
    const layer = createProgressMarksLayer({
      getTrack: () => track,
      getMarks: () => [mark({ key: "1.00-2.00", left: 1, width: 1 })]
    });
    expect(() => layer.sync()).not.toThrow();

    const created = makeBar();
    track = created.track;
    layer.sync();
    expect(created.track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`)).not.toBeNull();
    layer.dispose();
  });

  it("片段变了才重画，内容相同不重建节点", () => {
    const { track } = makeBar();
    let marks = [mark({ key: "1.00-2.00", left: 1, width: 1 })];
    const layer = createProgressMarksLayer({ getTrack: () => track, getMarks: () => marks });
    layer.sync();
    const host = track.querySelector(`[${PROGRESS_MARKS_ATTRIBUTE}]`);
    const firstBlock = host?.firstElementChild;

    layer.paint();
    expect(host?.firstElementChild).toBe(firstBlock);

    marks = [mark({ key: "3.00-4.00", left: 3, width: 1, color: "#f09a3e" })];
    layer.paint();
    expect(host?.firstElementChild).not.toBe(firstBlock);
    expect(host?.querySelector("[data-skipad-mark]")?.getAttribute("data-skipad-mark")).toBe(
      "3.00-4.00"
    );
    layer.dispose();
  });
});
