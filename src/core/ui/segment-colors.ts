import type { SegmentKind } from "../plugin/types";

/**
 * 画进站点原生进度条的实心颜色。
 *
 * 原生进度条在站点 DOM 里，不在浮层的 Shadow Root 里，取不到 --seg-* 变量，
 * 所以这里给出具体色值。数值与 globals.css 的 [data-theme="dark"] 一一对应，
 * segment-colors.test.ts 会读 globals.css 校验，改一边忘了另一边会失败。
 *
 * 进度条只有 4 像素高，斜纹、点阵在这么窄的条上会糊成噪点，所以统一用实心色；
 * 片段类型靠颜色区分，具体类型与时间在 Popup 的片段列表里看。
 */
export const SEGMENT_BAR_COLORS: Record<SegmentKind, string> = {
  sponsor: "#f2636a",
  insert: "#f09a3e",
  promo: "#5b93f0",
  self_promo: "#e5b949",
  topic: "#9a9aa6",
  unknown: "#22d3ee"
};

/** YouTube 自己的进度条是红色，广告片段改用蓝色区分。 */
export const YOUTUBE_AD_BAR_COLOR = "#3b82f6";

const AD_KINDS: ReadonlySet<SegmentKind> = new Set([
  "sponsor",
  "insert",
  "promo",
  "self_promo"
]);

export function segmentBarColor(kind: SegmentKind, site?: string | null): string {
  if (site === "youtube" && AD_KINDS.has(kind)) return YOUTUBE_AD_BAR_COLOR;
  return SEGMENT_BAR_COLORS[kind] ?? SEGMENT_BAR_COLORS.unknown;
}
