import type { AnalysisMode } from "../analysis/types";
import type { CacheStore } from "../ports/cache/store";
import type { LlmClient } from "../ports/llm/client";
import type { DecisionClient } from "../ports/decision/types";
import type { RuntimeSettings } from "../ports/messages";
import type { PlatformAdAdapter } from "../platform-ad/types";

/**
 * 插件契约与网站无关的数据模型。
 * 本文件不允许出现任何网站名、站点选择器或私有 API。
 */

/** 网站无关的视频标识：会话识别与缓存键的唯一依据。 */
export interface VideoKey {
  site: string;
  videoId: string;
  partId: string;
}

export const SEGMENT_KINDS = [
  "sponsor",
  "insert",
  "promo",
  "self_promo",
  "topic",
  "unknown"
] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const EVIDENCE_FAMILIES = [
  "jump_coordinate",
  "ad_word",
  "divergent_term",
  "density",
  "chapter",
  "transcript"
] as const;

export type EvidenceFamily = (typeof EVIDENCE_FAMILIES)[number];

/**
 * 片段的闭合状态，只用于「连续对话」分析过程中的增量结果：
 * - open：证据只读到 end 这个边界，广告可能还没结束，end 是临时值，禁止自动跳。
 * - closed（或缺省）：结尾已经在证据里出现过，可以作为跳跃终点。
 * 最终分析结果里不应残留 open；解析层会在最后一轮统一定稿。
 */
export type SegmentStatus = "open" | "closed";

/** 核心片段模型：缓存与界面只读这里的字段。 */
export interface Segment {
  start: number;
  end: number;
  kind: SegmentKind;
  confidence: number;
  evidence: string[];
  reason: string;
  families?: EvidenceFamily[];
  status?: SegmentStatus;
}

/**
 * 一次分析在每一轮下发的增量结果。
 * segments 始终是「到此为止的完整片段表」而不是本轮新增片段：
 * 连续对话可以修订、合并、删除之前轮次给出的片段，调用方必须整表替换。
 */
export interface AnalysisPartial {
  segments: Segment[];
  done: number;
  total: number;
  /** 本次分析使用的正片时长；覆盖率守卫与进度条共用，不能落回 0。 */
  durationSec?: number;
  /** 证据形态；danmaku 模式下自动跳门槛更严。 */
  mode?: AnalysisMode;
}

/** 字幕行。 */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** 视频章节：标题与时间区间，来自页面或站点 API。 */
export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export type Disposable = { dispose(): void };

/** 播放器读取与 seek 的最小契约，HTML video 实现见 core/player/html-video。 */
export interface PlayerAdapter {
  /** 找到当前播放器的 video 元素；找不到返回 null。 */
  findVideo(): HTMLVideoElement | null;
}

/** 播放器浮层挂载描述；挂载失败只降级浮层，不影响跳过。 */
export interface OverlayAdapter {
  /** 播放器容器选择器，Toast 浮层挂载为其子元素。 */
  anchor: string;
  /**
   * 站点原生进度条的轨道选择器。广告片段直接画在这条轨道上，
   * 轨道宽度的 0–100% 对应 0–视频总时长。
   */
  progressAnchor: string;
  /**
   * 「跳到结尾」胶囊的挂载选择器，找不到时退回进度条本体。
   * 轨道可能被 overflow:hidden 裁掉，胶囊要挂在不裁剪的祖先上。
   */
  snapAnchor?: string;
  /**
   * 色块层的层叠序号。站点把已播条包在更高的层叠上下文里时，
   * 靠 DOM 顺序盖不住，需要显式抬高；取值必须低于进度条滑块。
   */
  progressMarksZIndex?: number;
}

/** 受控的分析服务端口：密钥只在 Service Worker 读取，插件拿到的是代理客户端。 */
export interface AnalysisServices {
  llm: LlmClient;
  cache: CacheStore;
  readSettings(): Promise<RuntimeSettings>;
  /** 决策模型的代理客户端；没配接口地址时后台会报 not_configured。 */
  decision?: DecisionClient;
}

/** 一次片段分析的运行参数。 */
export interface SegmentAnalyzerRun {
  video: VideoKey;
  /** 发起分析时的播放位置。连续对话必须从头读，这个值目前只透传，不参与分块顺序。 */
  currentTime: number;
  signal: AbortSignal;
  /** 证据包与后续请求共用同一个取消信号；独立传它是为了兼容站点的分包取证据。 */
  evidenceSignal?: AbortSignal;
  /** 返回 true 时在下一个分块前停止，已完成分块保留但不写缓存。 */
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  /** 连续对话每轮的增量结果（完整片段表）；片段引擎用它即时展示。 */
  onPartial?: (partial: AnalysisPartial) => void;
}

/** 站点自己的片段分析器：证据装配、提示词与缓存键都留在站点目录。 */
export interface SegmentAnalyzer {
  analyze(run: SegmentAnalyzerRun): Promise<import("../analysis/types").AnalysisResult>;
}

/** 站点声明的能力，供 Options 与权限检查按站渲染。 */
export const SITE_CAPABILITIES = ["platform_ad"] as const;

export type SiteCapability = (typeof SITE_CAPABILITIES)[number];

/** 网站插件：页面匹配、适配器工厂与清单。 */
export interface SitePlugin {
  id: string;
  manifest: SiteManifest;
  match(url: URL): boolean;
  create(): SiteAdapter;
}

/** 站点声明；构建期由 site.json 提供同一份数据。 */
export interface SiteManifest {
  id: string;
  contentMatches: string[];
  excludeMatches: string[];
  hostPermissions: string[];
  capabilities: SiteCapability[];
}

export interface SiteAdapter {
  /** 从 URL 解析视频标识；解析失败（非视频页、非法参数）返回 null。 */
  resolveVideo(url: URL): VideoKey | null;
  /** SPA 导航观察；不实现时由会话控制器用定时轮询兜底。 */
  observeNavigation?(onChange: () => void): Disposable;
  player: PlayerAdapter;
  createSegmentAnalyzer?(services: AnalysisServices): SegmentAnalyzer;
  /** 决策模型的判定器；站点没实现时该站只使用连续对话分析器。 */
  createDecisionAnalyzer?(services: AnalysisServices): SegmentAnalyzer;
  createPlatformAdController?(): PlatformAdAdapter;
  overlay?: OverlayAdapter;
  /** 页面标题的站点清洗（去掉平台后缀），供 Popup 展示。 */
  pageTitle?(): string;
}
