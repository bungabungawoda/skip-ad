import type { ProgressMark } from "./progress-mark-geometry";
import { findHoverMark, HIDE_DELAY_MS, type SnapRect } from "./snap-hover-geometry";
import { createSnapHoverUi, type SnapHoverUi } from "./snap-hover-ui";

interface SnapHoverOptions {
  /** 当前要画的片段；悬停命中判定用它。 */
  getMarks: () => ProgressMark[];
  /** 播放器 video，预览环从播放位置弹到片段结尾时用。 */
  getVideo?: () => HTMLVideoElement | null;
  /** 站点原生进度条的轨道；百分比换算与容差都按它的宽度。 */
  getTrack: () => HTMLElement | null;
  /** 胶囊挂载点；不传时按轨道的祖先层级推算。 */
  getSnapHost?: () => HTMLElement | null;
  /** 点胶囊时通知控制器执行手动跳。 */
  onSkip?: (key: string) => void;
}

interface SnapHover {
  /** 轨道变化后重挂胶囊；返回挂载的进度条本体，未挂载返回 null。 */
  ensureUi(track: HTMLElement | null): HTMLElement | null;
  /** 是否还有挂载着的胶囊 UI。 */
  hasUi(): boolean;
  hide(): void;
  scheduleHide(): void;
  cancelHide(): void;
  /** 进度条上的指针移动：胶囊冒泡与片段命中判定在这里，拖动中由调用方拦截。 */
  onBarPointerMove(event: PointerEvent): void;
  /** 摘掉胶囊与预览环；样式表在没有任何胶囊层使用时一并移除。 */
  destroy(): void;
}

/** 悬停胶囊的隐藏计时：离开进度条和走向胶囊共用同一条延时。 */
function createHideTimer(delayMs: number, hide: () => void) {
  let timer: number | null = null;

  const cancel = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    cancel();
    timer = window.setTimeout(() => {
      timer = null;
      hide();
    }, delayMs);
  };

  return { cancel, schedule, isScheduled: () => timer !== null };
}

/** document 上的指针跟踪；只在胶囊显示时挂，隐藏后立刻摘掉。 */
function createDocumentTracker(onMove: (event: PointerEvent) => void) {
  let tracking = false;
  return {
    start(): void {
      if (tracking) return;
      tracking = true;
      document.addEventListener("pointermove", onMove, true);
    },
    stop(): void {
      if (!tracking) return;
      tracking = false;
      document.removeEventListener("pointermove", onMove, true);
    }
  };
}

interface PointerContext {
  ui: SnapHoverUi | null;
  options: SnapHoverOptions;
  hide: () => void;
  cancelHide: () => void;
  startTracking: () => void;
}

/** 进度条上的指针移动：胶囊自身的事件直接吞掉，其余按命中/未命中切换预览。 */
function handleBarPointerMove(event: PointerEvent, ctx: PointerContext): void {
  const { ui, options } = ctx;
  // 胶囊挂在进度条里面，鼠标在胶囊上移动时事件会冒泡到这里。这时指针的横
  // 坐标已经不在片段范围内，不能拿它重新判定悬停，否则胶囊会把自己关掉。
  if (ui?.isFromPill(event.target)) {
    ctx.cancelHide();
    return;
  }
  const rect = (options.getTrack()?.getBoundingClientRect() ?? null) as SnapRect | null;
  const mark = findHoverMark(options.getMarks(), event.clientX, rect);
  if (!mark || !ui?.render(mark, () => options.getVideo?.() ?? null)) {
    ctx.hide();
    return;
  }
  ctx.cancelHide();
  ctx.startTracking();
}

/**
 * 悬停 UI 的调度：隐藏计时、document 指针跟踪、轨道重挂。
 * 百分比换算与命中判定在 snap-hover-geometry，胶囊 DOM 与绘制在 snap-hover-ui。
 *
 * 交互边界：
 * - 环、胶囊都不拦截进度条自身的点击与拖动；只有胶囊接收点击。
 * - 胶囊固定在进度条上方 18 像素，出现后不再移动，尽量少挡站点缩略图。
 * - 鼠标从色块走到胶囊要经过一段空白，离开进度条后胶囊多留一会儿；
 *   指针还在往胶囊走的路上就不收。
 */
export function createSnapHover(options: SnapHoverOptions): SnapHover {
  let bar: HTMLElement | null = null;
  let ui: SnapHoverUi | null = null;

  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const hideTimer = createHideTimer(HIDE_DELAY_MS, () => hide());
  const { cancel: cancelHide, schedule: scheduleHide } = hideTimer;

  const onDocumentPointerMove = (event: PointerEvent): void => {
    if (!ui?.isShown()) return;
    if (ui.keepAlive(bar, event.clientX, event.clientY)) {
      cancelHide();
      return;
    }
    if (!hideTimer.isScheduled()) scheduleHide();
  };

  const tracker = createDocumentTracker(onDocumentPointerMove);
  const stopTracking = tracker.stop;
  const startTracking = tracker.start;

  function hide(): void {
    cancelHide();
    stopTracking();
    ui?.hideVisuals();
  }

  function destroy(): void {
    cancelHide();
    stopTracking();
    ui?.dispose();
    ui = null;
    bar = null;
  }

  function ensureUi(track: HTMLElement | null): HTMLElement | null {
    if (!track) return bar;
    // 胶囊不能挂在会被 overflow:hidden 裁掉的轨道里。站点能给出挂载点时用它，
    // 否则按「轨道 → wrap → 进度条本体」的常见三层结构推算。
    const host = options.getSnapHost?.() ?? track.parentElement?.parentElement ?? track.parentElement ?? track;
    if (host === bar && ui?.uiRoot.isConnected) return host;
    destroy();
    bar = host;
    ui = createSnapHoverUi({
      reducedMotion,
      onEnter: cancelHide,
      onLeave: scheduleHide,
      onSkip: (key) => {
        options.onSkip?.(key);
        hide();
      }
    });
    host.append(ui.uiRoot);
    return host;
  }

  function onBarPointerMove(event: PointerEvent): void {
    handleBarPointerMove(event, {
      ui,
      options,
      hide,
      cancelHide,
      startTracking
    });
  }

  return {
    ensureUi,
    hasUi: () => bar !== null || ui !== null,
    hide,
    scheduleHide,
    cancelHide,
    onBarPointerMove,
    destroy
  };
}
