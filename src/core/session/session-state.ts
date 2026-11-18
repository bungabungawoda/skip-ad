import type { AnalysisPolicy, AnalysisResult } from "../analysis/types";
import type { VideoKey } from "../plugin/types";
import { DEFAULT_POLICY } from "../policy/policy";
import type { SkipSegment } from "../player/segment-skipper";
import type { UiErrorInfo, UiSegmentView } from "../ui/state";

/** 一个页面会话的全部可变状态；由 SessionController 持有并分发给各协作者。 */
export interface Session {
  href: string;
  videoKey: VideoKey | null;
  page: number;
  video: HTMLVideoElement | null;
  result: AnalysisResult | null;
  /** 展示视图，唯一来源是 evaluateSessionPolicy。 */
  views: UiSegmentView[];
  auto: SkipSegment[];
  analyzing: boolean;
  configured: boolean;
  policy: AnalysisPolicy;
  loggedMissingConfig: boolean;
  loggedNoAnalyzer: boolean;
  loggedInvalidDuration: boolean;
  nextAnalysisAt: number;
  progress: { done: number; total: number } | null;
  error: UiErrorInfo | null;
  /** 每次开始分析自增；取消分析也自增，正在跑的那次发现 token 对不上就停。 */
  runToken: number;
  /** 用户主动取消了本轮分析，tick 不能立刻又把它拉起来。 */
  cancelled: boolean;
  /** 本轮分析的取消信号，用于中断在途 LLM 请求。 */
  abort: AbortController | null;
  /** 主分析从开始到拿到结果的墙钟耗时；还没有结果时为 null。 */
  mainElapsedMs: number | null;
  /** 「不是广告」标记；同一视频重新分析时保留。 */
  ignoredKeys: Set<string>;
}

/** 新会话：站点开关与策略沿用上一代，其余全部重置。 */
export function initialSession(href: string, previous?: Session): Session {
  return {
    href,
    videoKey: null,
    page: 1,
    video: null,
    result: null,
    views: [],
    auto: [],
    analyzing: false,
    configured: previous?.configured ?? false,
    policy: previous?.policy ?? DEFAULT_POLICY,
    loggedMissingConfig: false,
    loggedNoAnalyzer: false,
    loggedInvalidDuration: false,
    nextAnalysisAt: 0,
    progress: null,
    error: null,
    runToken: (previous?.runToken ?? 0) + 1,
    cancelled: false,
    abort: null,
    mainElapsedMs: null,
    ignoredKeys: new Set()
  };
}

/** 清掉一次分析的结果与展示，保留会话标识、设置与「不是广告」标记。 */
export function clearAnalysis(session: Session): void {
  session.result = null;
  session.views = [];
  session.auto = [];
  session.progress = null;
  session.error = null;
  session.mainElapsedMs = null;
}
