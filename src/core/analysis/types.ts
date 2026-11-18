import type { Segment, SegmentKind, VideoKey } from "../plugin/types";

/**
 * 分析流程的类型契约：策略、结果与警告。
 * mode 描述证据形态："full" 表示有字幕全文，"danmaku" 表示退化为弹幕等站内证据。
 * 策略判定（core/policy）按 mode 区分自动跳门槛，所以这个联合类型留在 core；
 * 各站点类型表引用同一联合。
 */

export type AnalysisMode = "full" | "danmaku";

export type AnalysisWarningCode =
  | "not_logged_in"
  | "subtitle_missing"
  | "subtitle_incomplete"
  | "subtitle_unavailable"
  | "subtitle_fetch_failed"
  /**
   * 没有读到当前播放器的字幕数据（桥不可用、播放器未就绪或内联快照不匹配）。
   * 它不等于「没有字幕」：视频可能有字幕，只是这次没读到。
   */
  | "player_data_unavailable"
  /**
   * 读到了字幕轨，但正文拉取失败（网络、403 或空正文）。
   * 与 B 站沿用弹幕的 subtitle_fetch_failed 分开，核心状态机据此进入 source_unavailable。
   */
  | "transcript_fetch_failed"
  | "danmaku_missing"
  /**
   * 字幕与弹幕都没读到，分析没有任何可读的上下文。
   * 它不等于「仅弹幕」，也不等于「无广告」：界面要单独说明这次没有分析。
   */
  | "no_context"
  | "llm_failed"
  | "partial"
  | "coverage_guard";

export interface AnalysisWarning {
  code: AnalysisWarningCode;
  message: string;
}

export type SegmentPolicy = "auto" | "mark" | "off";

export interface AnalysisPolicy {
  perKind: Record<SegmentKind, SegmentPolicy>;
  /** 类型优先级：同一时间命中多个类型时，先采用排在前面的类型策略。 */
  kindOrder: SegmentKind[];
  /** 用户改写的类型描述：发给模型时覆盖内置描述；缺省或为空时用内置描述。 */
  kindPromptOverrides?: Partial<Record<SegmentKind, string>>;
  confidenceThreshold: number;
  maxAutoCoverage: number;
  danmakuAutoEnabled: boolean;
}

/** 设置页一次改动只发自己碰过的字段；后台按当前已存策略合并。 */
export type AnalysisPolicyPatch = Omit<Partial<AnalysisPolicy>, "perKind"> & {
  perKind?: Partial<Record<SegmentKind, SegmentPolicy>>;
};

export interface PolicyResult {
  auto: Segment[];
  mark: Segment[];
  off: Segment[];
  coverage: number;
  guardTriggered: boolean;
}

export interface AnalysisResult {
  /** 缓存键：site:videoId:partId:analyzerId:analyzerVersion:model:promptVersion。 */
  videoKey: string;
  /** 分析结果对应的视频标识；partId 是站点元数据确定后的最终形态。 */
  video: VideoKey;
  mode: AnalysisMode;
  segments: Segment[];
  warnings: AnalysisWarning[];
  /** 本次分析实际使用的正片时长（秒）。策略与覆盖率只用这个值。 */
  durationSec: number;
}
