import type { ProgressMark } from "./progress-mark-geometry";
import { clampPercent, findMarkAt } from "./progress-mark-geometry";

/** 悬停判定容差：色块附近 6 像素内算命中。 */
const SNAP_TOLERANCE_PX = 6;
/** 胶囊固定在进度条上方 18 像素，出现后不再移动。 */
export const PILL_LIFT_PX = 18;
/** 胶囊贴边时留的横向余量，避免被进度条边缘裁掉。 */
const PILL_EDGE_PX = 40;
/** 指针离开进度条和胶囊之后，胶囊再留一会儿，留给鼠标往上走的这几帧。 */
export const HIDE_DELAY_MS = 160;
/** 判断「指针还在往胶囊走」时，给进度条、胶囊和中间通道留的余量。 */
const KEEP_MARGIN_PX = 8;

/** 轨道矩形可以是 DOM 的 DOMRect，也可以是测试构造的同形状对象。 */
export interface SnapRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

/** 指针横坐标换算成轨道百分比；轨道不存在或宽度为零时返回 null。 */
export function percentAt(clientX: number, rect: SnapRect | null): number | null {
  if (!rect || rect.width <= 0) return null;
  return clampPercent(((clientX - rect.left) / rect.width) * 100);
}

/** 当前播放位置占全片的百分比；时长没就绪时按 0 算。 */
export function playheadPercent(video: HTMLVideoElement | null | undefined): number {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return 0;
  return clampPercent((video.currentTime / video.duration) * 100);
}

/** 按像素容差找出指针命中的色块；多个命中时取最近的。 */
export function findHoverMark(
  marks: ProgressMark[],
  clientX: number,
  rect: SnapRect | null
): ProgressMark | null {
  const percent = percentAt(clientX, rect);
  if (percent === null) return null;
  const width = Math.max(1, rect?.width ?? 1);
  return findMarkAt(marks, percent, (SNAP_TOLERANCE_PX / width) * 100);
}

export function insideRect(rect: SnapRect, x: number, y: number): boolean {
  return (
    x >= rect.left - KEEP_MARGIN_PX &&
    x <= rect.right + KEEP_MARGIN_PX &&
    y >= rect.top - KEEP_MARGIN_PX &&
    y <= rect.bottom + KEEP_MARGIN_PX
  );
}

/** 指针是否还停在「进度条 → 胶囊」这条路上，含两者之间的竖直通道。 */
export function keepAliveAt(
  barRect: SnapRect,
  pillRect: SnapRect,
  x: number,
  y: number
): boolean {
  if (insideRect(barRect, x, y) || insideRect(pillRect, x, y)) return true;
  return (
    y <= barRect.top &&
    y >= pillRect.top &&
    x >= pillRect.left - KEEP_MARGIN_PX &&
    x <= pillRect.right + KEEP_MARGIN_PX
  );
}

/** 六位色值加透明度；颜色不是六位十六进制时退回中性灰。 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return `rgba(244, 244, 245, ${alpha})`;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return `rgba(244, 244, 245, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 胶囊的横向位置：按片段结尾对齐，同时不越过进度条两端。 */
export function pillLeftStyle(endPercent: number): string {
  return `clamp(${PILL_EDGE_PX}px, ${endPercent}%, calc(100% - ${PILL_EDGE_PX}px))`;
}

/** 预览环的两层光晕跟着片段颜色走。 */
export function ringShadow(color: string): string {
  return `0 0 0 5px ${withAlpha(color, 0.18)}, 0 0 18px ${withAlpha(color, 0.45)}`;
}
