import type { UiPhase } from "./state";

/**
 * 工具栏角标的唯一实现：内容脚本和 Popup 都从这里取文案。
 * 两份实现曾在「字幕数据未就绪」上分叉：Popup 说没读到，角标却说 AD 0。
 *
 * 分析开关关闭时不显示角标：这时没有任何判定，显示「AD 0」等于宣称没有广告。
 */
export function badgeTextFor(phase: UiPhase, segmentCount: number): string {
  if (phase === "disabled") return "";
  if (phase === "cancelled") return "!";
  if (phase === "ready") return `AD ${segmentCount}`;
  if (phase === "no_ads") return "AD 0";
  if (phase === "analyzing" || phase === "danmaku_only") return "…";
  // 字幕数据没读到：可能是播放器桥/正文拉取失败，不能显示成「没有广告」。
  if (phase === "source_unavailable") return "!";
  // 无字幕也无弹幕：没有可读内容，不能显示「AD 0」冒充「没有广告」。
  if (phase === "no_context") return "∅";
  return "!";
}
