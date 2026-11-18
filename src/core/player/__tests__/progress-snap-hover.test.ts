// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapHover } from "../progress-snap-hover";
import type { ProgressMark } from "../progress-mark-geometry";

/**
 * 悬停胶囊的行为契约：命中色块才出现、点击执行手动跳、
 * 移出色块收起、主题片段不提供「跳到结尾」。
 */

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

/** 轨道宽度固定 1000px，百分比坐标 = 像素坐标 / 10。 */
function setup(marks: ProgressMark[]) {
  const track = document.createElement("div");
  const wrap = document.createElement("div");
  const bar = document.createElement("div");
  wrap.append(track, bar);
  document.body.append(wrap);
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 20,
    height: 20,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect);
  const onSkip = vi.fn();
  const hover = createSnapHover({
    getMarks: () => marks,
    getTrack: () => track,
    onSkip
  });
  hover.ensureUi(track);
  return { hover, onSkip, bar };
}

function pointerAt(hover: ReturnType<typeof createSnapHover>, x: number): void {
  hover.onBarPointerMove({
    clientX: x,
    clientY: 10,
    target: document.body
  } as unknown as PointerEvent);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("悬停胶囊", () => {
  it("命中色块出现胶囊，点击执行手动跳并收起", () => {
    const { hover, onSkip } = setup([mark()]);
    pointerAt(hover, 500);
    const pill = document.querySelector<HTMLButtonElement>("[data-skipad-snap-pill]");
    expect(pill?.style.display).toBe("inline-flex");
    expect(pill?.dataset.skipadKey).toBe("10.00-20.00");
    pill?.click();
    expect(onSkip).toHaveBeenCalledWith("10.00-20.00");
    expect(pill?.style.display).toBe("none");
  });

  it("移出色块后胶囊收起", () => {
    const { hover } = setup([mark()]);
    pointerAt(hover, 500);
    pointerAt(hover, 100);
    const pill = document.querySelector<HTMLButtonElement>("[data-skipad-snap-pill]");
    expect(pill?.style.display).toBe("none");
  });

  it("主题片段不提供「跳到结尾」", () => {
    const { hover } = setup([mark({ kind: "topic", label: "主题" })]);
    pointerAt(hover, 500);
    const pill = document.querySelector<HTMLButtonElement>("[data-skipad-snap-pill]");
    expect(pill?.style.display).toBe("none");
  });

  it("没挂载轨道时 ensureUi 不炸，销毁后 DOM 摘干净", () => {
    const hover = createSnapHover({ getMarks: () => [], getTrack: () => null });
    expect(hover.ensureUi(null)).toBeNull();
    const { bar } = setup([mark()]);
    hover.destroy();
    expect(bar.querySelector("[data-skipad-snap-ui]")).toBeNull();
  });
});
