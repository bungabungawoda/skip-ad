import { clampPercent, nearestMarkEnd, type ProgressMark } from "./progress-mark-geometry";
import { createSnapHover } from "./progress-snap-hover";
import { destroySnapStyleIfUnused } from "./snap-hover-ui";

/**
 * 把广告片段画进站点原生进度条，并在悬停时给出「跳到结尾」胶囊。
 *
 * 本文件管三件事：色块层的挂载与重画、悬停胶囊的时序、拖动松手后的吸附。
 * 几何换算在 progress-mark-geometry，悬停判定在 progress-snap-hover，
 * 胶囊与预览环的 DOM 在 snap-hover-ui。
 *
 * 交互边界：
 * - 色块、预览环、胶囊都不拦截进度条自身的点击与拖动。
 * - 只有胶囊本身接收点击；点胶囊才跳。
 * - 拖动松手落在片段结尾 16 像素内时，补一次跳转（按住 Alt 取消）。
 */

/** 色块层的标记属性，便于在真实页面里确认挂载点。 */
export const PROGRESS_MARKS_ATTRIBUTE = "data-skipad-progress-marks";

/** 拖动松手落在片段结尾这么近时，补一次跳到结尾。 */
const SNAP_END_TOLERANCE_PX = 16;
/** 位移不超过这个距离不算拖动：只是点了一下进度条。 */
const DRAG_THRESHOLD_PX = 4;

function createMarksElement(zIndex?: number): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(PROGRESS_MARKS_ATTRIBUTE, "");
  // 默认不设 z-index：靠 DOM 顺序盖在 buffer/current 之后。站点把已播条
  // 包进更高的层叠上下文时，由适配器给 z-index 抬高；取值必须低于滑块。
  const styles = [
    "position:absolute",
    "inset:0",
    "pointer-events:none",
    "overflow:hidden",
    "border-radius:inherit"
  ];
  if (zIndex !== undefined) styles.push(`z-index:${zIndex}`);
  element.style.cssText = styles.join(";");
  return element;
}

/** 色块层本身：只管把片段 span 画进轨道，内容没变时不动 DOM。 */
interface MarksDom {
  /** 当前轨道；未挂载时为 null。 */
  readonly track: HTMLElement | null;
  /** 轨道被站点重建时搬层过去，并把色块放回最后以盖在已播条之上。 */
  attach(track: HTMLElement): void;
  /** 片段变化后重画。 */
  paint(getMarks: () => ProgressMark[]): void;
  detach(): void;
}

function createMarksDom(options: { zIndex?: number } = {}): MarksDom {
  let track: HTMLElement | null = null;
  let marksLayer: HTMLElement | null = null;
  let painted = "";

  return {
    get track() {
      return track;
    },
    attach(next: HTMLElement): void {
      if (
        next !== track ||
        !marksLayer ||
        !marksLayer.isConnected ||
        marksLayer.parentElement !== next
      ) {
        marksLayer?.remove();
        marksLayer = createMarksElement(options.zIndex);
        next.append(marksLayer);
        track = next;
        painted = "";
      } else if (next.lastElementChild !== marksLayer) {
        // 站点重排轨道子节点后把色块放回最后，保证盖在已播条之上。
        next.append(marksLayer);
      }
    },
    paint(getMarks: () => ProgressMark[]): void {
      if (!marksLayer) return;
      const marks = getMarks();
      const signature = JSON.stringify(marks);
      if (signature === painted) return;
      painted = signature;
      const fragment = document.createDocumentFragment();
      for (const mark of marks) {
        const block = document.createElement("span");
        block.setAttribute("data-skipad-mark", mark.key);
        block.style.cssText = [
          "position:absolute",
          "top:0",
          "bottom:0",
          `left:${mark.left}%`,
          `width:${mark.width}%`,
          "min-width:2px",
          `background-color:${mark.color}`
        ].join(";");
        fragment.append(block);
      }
      marksLayer.replaceChildren(fragment);
    },
    detach(): void {
      marksLayer?.remove();
      marksLayer = null;
      track = null;
      painted = "";
    }
  };
}

interface ProgressMarksLayer {
  /** 重新查找轨道；站点重建进度条时把色块和胶囊搬过去。 */
  sync(): void;
  /** 片段或时长变化后重画；内容没变时不动 DOM。 */
  paint(): void;
  dispose(): void;
}

interface ProgressMarksOptions {
  /** 站点原生进度条的轨道；找不到返回 null。 */
  getTrack: () => HTMLElement | null;
  /** 胶囊挂载点；不传时按轨道祖先推算。 */
  getSnapHost?: () => HTMLElement | null;
  /** 当前要画的片段；没有片段返回空数组。 */
  getMarks: () => ProgressMark[];
  /** 播放器 video，用来取当前播放位置给预览环做起点。 */
  getVideo?: () => HTMLVideoElement | null;
  /** 点胶囊或松手吸附时通知控制器执行手动跳。 */
  onSkip?: (key: string) => void;
  /** 色块层的层叠序号；站点已播条层级更高时由适配器提供。 */
  layerZIndex?: number;
}

/** 拖动松手后的吸附：只处理「确实拖了、没按 Alt、落在片段结尾附近」这一种情况。 */
function createDragSnap(options: {
  getMarks: () => ProgressMark[];
  getTrack: () => HTMLElement | null;
  onSkip?: (key: string) => void;
  isDisposed: () => boolean;
  hideHover: () => void;
}) {
  let dragging = false;
  let downX: number | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    downX = event.clientX;
    options.hideHover();
  };

  const onPointerUp = (event: PointerEvent): void => {
    const wasDragging = dragging;
    const startX = downX;
    dragging = false;
    downX = null;
    if (!wasDragging || startX === null) return;
    if (Math.abs(event.clientX - startX) <= DRAG_THRESHOLD_PX) return;
    if (event.altKey) return;
    const track = options.getTrack();
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const percent = clampPercent(((event.clientX - rect.left) / rect.width) * 100);
    const mark = nearestMarkEnd(
      options.getMarks(),
      percent,
      (SNAP_END_TOLERANCE_PX / rect.width) * 100
    );
    if (!mark || !options.onSkip) return;
    // 站点自己的 seek 先跑完，再补一次跳到结尾，避免被站点的落点覆盖。
    const key = mark.key;
    window.setTimeout(() => {
      if (!options.isDisposed()) options.onSkip?.(key);
    }, 0);
  };

  const onWindowPointerUp = (): void => {
    dragging = false;
    downX = null;
  };

  return {
    onPointerDown,
    onPointerUp,
    onWindowPointerUp,
    isDragging: () => dragging
  };
}

export function createProgressMarksLayer(options: ProgressMarksOptions): ProgressMarksLayer {
  const dom = createMarksDom(
    options.layerZIndex === undefined ? {} : { zIndex: options.layerZIndex }
  );
  const hover = createSnapHover({
    getMarks: options.getMarks,
    ...(options.getVideo ? { getVideo: options.getVideo } : {}),
    ...(options.getSnapHost ? { getSnapHost: options.getSnapHost } : {}),
    getTrack: () => dom.track,
    ...(options.onSkip ? { onSkip: options.onSkip } : {})
  });

  let bar: HTMLElement | null = null;
  let disposed = false;
  const drag = createDragSnap({
    getMarks: options.getMarks,
    getTrack: () => dom.track,
    ...(options.onSkip ? { onSkip: options.onSkip } : {}),
    isDisposed: () => disposed,
    hideHover: () => hover.hide()
  });

  const attachBarListeners = (host: HTMLElement): void => {
    host.addEventListener("pointermove", onBarPointerMove);
    host.addEventListener("pointerleave", onBarPointerLeave);
    host.addEventListener("pointerdown", drag.onPointerDown);
    host.addEventListener("pointerup", drag.onPointerUp);
  };

  const detachBarListeners = (host: HTMLElement): void => {
    host.removeEventListener("pointermove", onBarPointerMove);
    host.removeEventListener("pointerleave", onBarPointerLeave);
    host.removeEventListener("pointerdown", drag.onPointerDown);
    host.removeEventListener("pointerup", drag.onPointerUp);
  };

  const destroyUi = (): void => {
    if (bar) {
      detachBarListeners(bar);
      bar = null;
    }
    hover.destroy();
  };

  const sync = (): void => {
    const next = options.getTrack();
    if (!next) {
      if (dom.track || hover.hasUi()) {
        dom.detach();
        destroyUi();
      }
      return;
    }
    // 轨道被站点重建时，旧色块会跟着旧节点一起消失，这里搬到新轨道。
    dom.attach(next);
    const host = hover.ensureUi(dom.track);
    if (host && host !== bar) {
      if (bar) detachBarListeners(bar);
      bar = host;
      attachBarListeners(bar);
    }
    dom.paint(options.getMarks);
  };

  const onBarPointerMove = (event: PointerEvent): void => {
    if (drag.isDragging()) {
      hover.hide();
      return;
    }
    hover.onBarPointerMove(event);
  };

  const onBarPointerLeave = (): void => {
    if (drag.isDragging()) {
      hover.hide();
      return;
    }
    // 不能立刻收：胶囊浮在进度条上方 18 像素处，鼠标要往上走一段才够得着。
    hover.scheduleHide();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pointerup", drag.onWindowPointerUp);
    dom.detach();
    destroyUi();
    destroySnapStyleIfUnused();
  };

  window.addEventListener("pointerup", drag.onWindowPointerUp);

  return { sync, paint: () => dom.paint(options.getMarks), dispose };
}
