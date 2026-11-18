import type { Segment } from "../plugin/types";
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisWarningCode,
  SegmentPolicy
} from "../analysis/types";

/** 内容脚本与弹窗共用的本地统计形状，初始值见 EMPTY_SKIP_STATS。 */
export interface SkipStats {
  skippedCount: number;
  skippedSeconds: number;
  undoCount: number;
}

export const EMPTY_SKIP_STATS: SkipStats = {
  skippedCount: 0,
  skippedSeconds: 0,
  undoCount: 0
};

/** Popup 顶部状态条与状态卡的九种状态。 */
export type UiPhase =
  | "analyzing"
  | "ready"
  | "no_ads"
  | "no_key"
  | "danmaku_only"
  | "source_unavailable"
  | "no_context"
  | "failed"
  | "permission"
  /** 用户关掉了站点分析开关：没有判定，不能说「没有广告」。 */
  | "disabled"
  /** 用户取消了分析：没有结果，且不会自动重跑。 */
  | "cancelled";

/**
 * 字幕与弹幕都没读到。没有可读上下文时不能显示「仅弹幕」，
 * 更不能让角标显示「AD 0」冒充「没有广告」。
 */
function hasNoContext(warnings: readonly AnalysisWarningCode[]): boolean {
  return warnings.includes("no_context");
}

/** 「未登录 · 仅弹幕」状态对应的警告码。 */
export const DANMAKU_WARNING_CODES: AnalysisWarningCode[] = [
  "not_logged_in",
  "subtitle_missing",
  "subtitle_unavailable",
  "subtitle_fetch_failed"
];

/** 「仅弹幕」的具体原因，Popup 按它选文案。 */
export type DanmakuReason =
  | "not_logged_in"
  | "subtitle_foreign"
  | "subtitle_unreadable"
  | "subtitle_missing"
  | "unknown";

/**
 * 从警告码里挑出「为什么只剩弹幕」，按用户能做的动作排序：先看登录，
 * 再看字幕轨本身的问题。同一份结果可能同时有多个码（未登录时也会记
 * subtitle_missing），所以顺序要固定。
 */
export function danmakuReason(warnings: AnalysisWarningCode[]): DanmakuReason {
  if (warnings.includes("not_logged_in")) return "not_logged_in";
  if (warnings.includes("subtitle_incomplete")) return "subtitle_foreign";
  if (warnings.includes("subtitle_fetch_failed") || warnings.includes("subtitle_unavailable")) {
    return "subtitle_unreadable";
  }
  if (warnings.includes("subtitle_missing")) return "subtitle_missing";
  return "unknown";
}

/** 致命警告码：出现即进入「失败」状态。 */
export const FATAL_WARNING_CODES: AnalysisWarningCode[] = ["llm_failed"];

/** 片段在 Popup 与进度条色块里的一条展示视图。 */
export interface UiSegmentView {
  segment: Segment;
  policy: SegmentPolicy;
  /**
   * 原始片段身份（未被重叠裁剪改过起止）。Popup 的命令必须用它，
   * 否则裁剪块的「跳过 / 撤销 / 不是广告」在内容脚本里找不到对应片段。
   */
  key?: string;
}

/** 结构化错误：来源是 LlmError.kind、status 和分析耗时，不包含 Key 与额外请求头。 */
export interface UiErrorInfo {
  kind: string;
  status?: number;
  message: string;
  /** 本次分析从开始到失败耗时的毫秒数。 */
  elapsedMs: number;
  /** 失败前已解析出的片段数。 */
  newSegments: number;
}

interface UiProgress {
  done: number;
  total: number;
}

/** 平台广告即时快进的展示快照。 */
interface UiPlatformAdState {
  phase: "no_ad" | "fast_forwarding" | "waiting" | "given_up";
  attempts: number;
  appearance: number;
}

/** 内容脚本会话的完整快照，Popup 通过 ui.getState 读取。 */
export interface UiState {
  href: string;
  /** 当前站点插件 id；未选到插件时为 null。 */
  site: string | null;
  /** 平台广告即时跳过状态；站点没有该能力时为 null。 */
  platformAd: UiPlatformAdState | null;
  /** 站点分析开关；关闭时相位是 disabled，角标不显示。 */
  analysisEnabled: boolean;
  /** 平台广告快进开关；关闭时卡片显示「已关闭」，不显示「等待快进」。 */
  platformAdEnabled: boolean;
  /** 本轮分析被用户取消；Popup 要给「重新分析」入口。 */
  cancelled: boolean;
  phase: UiPhase;
  /** 本次分析的缓存键；非空表示结果已进 5 分钟缓存。 */
  cacheKey: string | null;
  /** 当前视频的站点内标识；仅展示用途。 */
  videoId: string | null;
  /** 最终视频键（site:videoId:partId）；扩展内部按它标识当前视频。 */
  videoKey: string | null;
  page: number;
  title: string;
  durationSec: number;
  currentTime: number;
  mode: AnalysisMode | null;
  segments: UiSegmentView[];
  progress: UiProgress | null;
  warnings: AnalysisWarningCode[];
  error: UiErrorInfo | null;
  /** 结果里有分块失败或被校验丢弃：界面要标「不完整」，不能当成「无广告」。 */
  incomplete: boolean;
  stats: SkipStats;
}

export function emptyUiState(href: string): UiState {
  return {
    href,
    site: null,
    platformAd: null,
    analysisEnabled: true,
    platformAdEnabled: true,
    cancelled: false,
    phase: "analyzing",
    cacheKey: null,
    videoId: null,
    videoKey: null,
    page: 1,
    title: "",
    durationSec: 0,
    currentTime: 0,
    mode: null,
    segments: [],
    progress: null,
    warnings: [],
    error: null,
    incomplete: false,
    stats: { ...EMPTY_SKIP_STATS }
  };
}

const FATAL_CODES = new Set<AnalysisWarningCode>(FATAL_WARNING_CODES);
const DANMAKU_CODES = new Set<AnalysisWarningCode>(DANMAKU_WARNING_CODES);

/**
 * 状态按固定优先级推导：失败 > 无 Key > 分析中 > 已就绪 >
 * 字幕数据未就绪 > 无上下文 > 未登录·仅弹幕 > 无广告。
 * 权限状态由 Popup 用 chrome.permissions.contains 判断后覆盖，内容脚本判断不了。
 *
 * 「没读到」用 player_data_unavailable / transcript_fetch_failed 表示，它们
 * 不代表视频没有字幕；「没有字幕」用 subtitle_missing + no_context 表示。
 * 站点文案由 Popup 处理，这里不出现任何站点名。
 */
export function derivePhase(input: {
  analyzing: boolean;
  configured: boolean;
  result: Pick<AnalysisResult, "mode" | "segments" | "warnings"> | null;
  error: UiErrorInfo | null;
  /**
   * 展示层可见的片段数（已过滤「不是广告」与策略 off）。
   * 缺省时退回原始片段数，兼容只关心状态机的调用方。
   */
  visibleSegments?: number;
  /**
   * 结果里有分块失败或被校验丢弃。一条片段都没拿到时必须进失败态：
   * 那表示分析没读成，不是「这条视频没有广告」。
   */
  incomplete?: boolean;
  /** 站点分析开关；显式传 false 时优先返回 disabled。 */
  analysisEnabled?: boolean;
  /** 用户取消了本轮分析且没有结果。 */
  cancelled?: boolean;
}): UiPhase {
  if (input.analysisEnabled === false) return "disabled";
  if (input.error) return "failed";
  if (input.result?.warnings.some((w) => FATAL_CODES.has(w.code))) {
    return "failed";
  }
  if (!input.configured) return "no_key";
  if (input.analyzing) return "analyzing";
  if (input.result) {
    const visible = input.visibleSegments ?? input.result.segments.length;
    if (visible > 0) return "ready";
    if (input.incomplete === true) return "failed";
    const codes = input.result.warnings.map((warning) => warning.code);
    // 这两个码只由「读不到当前播放器」的路径产生，与站点无关。
    if (codes.includes("player_data_unavailable") || codes.includes("transcript_fetch_failed")) {
      return "source_unavailable";
    }
    if (hasNoContext(codes)) return "no_context";
    if (input.result.mode === "danmaku" || codes.some((code) => DANMAKU_CODES.has(code))) {
      return "danmaku_only";
    }
    return "no_ads";
  }
  if (input.cancelled === true) return "cancelled";
  return "analyzing";
}

