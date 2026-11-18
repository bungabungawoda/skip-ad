import type { ProgressMark } from "./progress-mark-geometry";
import { formatClock } from "../lib/time";
import { t } from "../i18n";
import {
  keepAliveAt,
  pillLeftStyle,
  playheadPercent,
  ringShadow,
  PILL_LIFT_PX,
  type SnapRect
} from "./snap-hover-geometry";

export const SNAP_UI_ATTRIBUTE = "data-skipad-snap-ui";
export const SNAP_RING_ATTRIBUTE = "data-skipad-snap-ring";
export const SNAP_PILL_ATTRIBUTE = "data-skipad-snap-pill";
const SNAP_STYLE_ID = "skipad-snap-style";

function ensureSnapStyle(): void {
  if (document.getElementById(SNAP_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SNAP_STYLE_ID;
  style.textContent = [
    `[${SNAP_PILL_ATTRIBUTE}]:hover{background:#ffffff!important}`,
    `[${SNAP_PILL_ATTRIBUTE}]:focus-visible{outline:2px solid #4ade80;outline-offset:2px}`
  ].join("");
  document.head.append(style);
}

/** 扩展重载时新旧实例会短暂共存；还有别的胶囊层在用这份样式就不要删。 */
export function destroySnapStyleIfUnused(): void {
  if (!document.querySelector(`[${SNAP_UI_ATTRIBUTE}]`)) {
    document.getElementById(SNAP_STYLE_ID)?.remove();
  }
}

/** 胶囊层的四个节点：uiRoot 装着预览环和胶囊。 */
interface SnapUiNodes {
  uiRoot: HTMLDivElement;
  ring: HTMLDivElement;
  pill: HTMLButtonElement;
  pillIcon: SVGElement;
  pillTime: HTMLElement;
}

/** 一次性搭出预览环与胶囊的 DOM，不绑定任何事件。 */
function buildSnapUi(): SnapUiNodes {
  const uiRoot = document.createElement("div");
  uiRoot.setAttribute(SNAP_UI_ATTRIBUTE, "");
  uiRoot.style.cssText = [
    "position:absolute",
    "left:0",
    "right:0",
    "top:0",
    "bottom:0",
    "z-index:10",
    "pointer-events:none",
    "overflow:visible"
  ].join(";");

  const ring = document.createElement("div");
  ring.setAttribute(SNAP_RING_ATTRIBUTE, "");
  ring.style.cssText = [
    "position:absolute",
    "top:50%",
    "left:0",
    "width:14px",
    "height:14px",
    "border-radius:50%",
    // 用系统配色而不是写死浅色：浅色播放器上硬编码的深色圆点会看不见。
    "border:2px solid Canvas",
    "background:CanvasText",
    "transform:translate(-50%,-50%)",
    "box-shadow:0 0 0 5px rgba(242,99,106,.18),0 0 18px rgba(242,99,106,.45)",
    "opacity:0",
    "transition:left 220ms cubic-bezier(.22,.9,.24,1.02),opacity 120ms ease",
    "pointer-events:none",
    "box-sizing:border-box"
  ].join(";");

  const pill = document.createElement("button");
  pill.type = "button";
  pill.setAttribute(SNAP_PILL_ATTRIBUTE, "");
  pill.style.cssText = [
    "position:absolute",
    "left:0",
    "bottom:18px",
    "transform:translateX(-50%)",
    "display:none",
    "align-items:center",
    "gap:4px",
    "min-height:28px",
    "padding:0 8px",
    "border-radius:999px",
    "border:1px solid color-mix(in srgb, CanvasText 25%, transparent)",
    "background:Canvas",
    "color:CanvasText",
    'font:600 12px/1 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    "box-shadow:0 8px 24px rgba(0,0,0,.45)",
    "cursor:pointer",
    "white-space:nowrap",
    "pointer-events:auto",
    "box-sizing:border-box"
  ].join(";");
  pill.innerHTML =
    '<svg data-skipad-pill-icon viewBox="0 0 24 24" aria-hidden="true" style="width:12px;height:12px;flex:none;color:#f2636a;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="m5 4 10 8-10 8z"></path><path d="M19 5v14"></path></svg>' +
    '<span data-skipad-pill-time style="font-family:&quot;JetBrains Mono&quot;,ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:500;color:color-mix(in srgb, CanvasText 60%, transparent)"></span>';

  return {
    uiRoot,
    ring,
    pill,
    pillIcon: pill.querySelector<SVGElement>("[data-skipad-pill-icon]"),
    pillTime: pill.querySelector<HTMLElement>("[data-skipad-pill-time]")
  } as SnapUiNodes;
}

interface SnapHoverUiHandlers {
  /** 指针进胶囊：取消收起计时。 */
  onEnter(): void;
  /** 指针离胶囊：安排收起。 */
  onLeave(): void;
  /** 点胶囊：执行手动跳并收起整个悬停。 */
  onSkip(key: string): void;
  reducedMotion: boolean;
}

export interface SnapHoverUi {
  readonly uiRoot: HTMLDivElement;
  /** 预览环是否可见；决定要不要开始跟踪 document 上的指针。 */
  isShown(): boolean;
  /** 画一次悬停。主题内容返回 false，调用方应把整个悬停收起。 */
  render(mark: ProgressMark, getVideo: () => HTMLVideoElement | null): boolean;
  hideVisuals(): void;
  isFromPill(target: EventTarget | null): boolean;
  /** 指针是否还在进度条到胶囊的路上。 */
  keepAlive(bar: HTMLElement | null, x: number, y: number): boolean;
  dispose(): void;
}

/**
 * 胶囊 DOM 与它自己的事件：预览环、按钮、命中后的绘制。
 * 隐藏计时、document 指针跟踪与轨道重挂留在 createSnapHover。
 */
export function createSnapHoverUi(handlers: SnapHoverUiHandlers): SnapHoverUi {
  const { uiRoot, ring, pill, pillIcon, pillTime } = buildSnapUi();
  ensureSnapStyle();
  uiRoot.append(ring, pill);

  let hoverKey: string | null = null;
  let ringShown = false;

  const onEnter = (): void => handlers.onEnter();
  const onLeave = (): void => {
    if (ringShown) handlers.onLeave();
  };
  /** 不让胶囊的按下冒泡到进度条，否则会被当成一次拖动，站点还会顺手 seek 一次。 */
  const onPress = (event: Event): void => event.stopPropagation();
  const onClick = (event: Event): void => {
    event.stopPropagation();
    const key = pill.dataset.skipadKey;
    if (key) handlers.onSkip(key);
  };

  pill.addEventListener("pointerenter", onEnter);
  pill.addEventListener("pointerleave", onLeave);
  pill.addEventListener("pointerdown", onPress);
  pill.addEventListener("pointerup", onPress);
  pill.addEventListener("mousedown", onPress);
  pill.addEventListener("mouseup", onPress);
  pill.addEventListener("click", onClick);

  return {
    uiRoot,
    isShown: () => ringShown,
    render(mark, getVideo) {
      // 主题内容不是广告，不提供「跳到结尾」。
      if (mark.kind === "topic") return false;
      const endPercent = mark.left + mark.width;
      pillIcon.style.color = mark.color;
      pillTime.textContent = formatClock(mark.end);
      pill.style.left = pillLeftStyle(endPercent);
      // 位置只在这里定一次。站点缩略图出现得晚，胶囊也不跟着抬。
      pill.style.bottom = `${PILL_LIFT_PX}px`;
      pill.style.display = "inline-flex";
      pill.style.pointerEvents = "auto";
      pill.setAttribute(
        "aria-label",
        t("player.skipAria", { kind: mark.label, time: formatClock(mark.end) })
      );
      pill.dataset.skipadKey = mark.key;

      if (hoverKey !== mark.key) {
        hoverKey = mark.key;
        if (!ringShown) {
          // 第一次出现时从当前播放位置弹到结尾；同一段内移动不再回到起点。
          ring.style.transition = "none";
          ring.style.left = `${playheadPercent(getVideo())}%`;
          void ring.offsetWidth;
        }
        ring.style.transition = handlers.reducedMotion
          ? "none"
          : "left 220ms cubic-bezier(.22,.9,.24,1.02), opacity 120ms ease";
        ring.style.left = `${endPercent}%`;
      }
      ring.style.boxShadow = ringShadow(mark.color);
      ring.style.opacity = "1";
      ringShown = true;
      return true;
    },
    hideVisuals() {
      ring.style.opacity = "0";
      pill.style.display = "none";
      pill.style.pointerEvents = "none";
      hoverKey = null;
      ringShown = false;
    },
    isFromPill: (target) => target instanceof Node && pill.contains(target),
    keepAlive(bar, x, y) {
      if (!bar) return false;
      return keepAliveAt(
        bar.getBoundingClientRect() as SnapRect,
        pill.getBoundingClientRect() as SnapRect,
        x,
        y
      );
    },
    dispose() {
      pill.removeEventListener("pointerenter", onEnter);
      pill.removeEventListener("pointerleave", onLeave);
      pill.removeEventListener("pointerdown", onPress);
      pill.removeEventListener("pointerup", onPress);
      pill.removeEventListener("mousedown", onPress);
      pill.removeEventListener("mouseup", onPress);
      pill.removeEventListener("click", onClick);
      uiRoot.remove();
    }
  };
}
