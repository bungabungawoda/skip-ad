import type { AnalysisPolicy } from "../../../core/analysis/types";
import type {
  AnalysisPartial,
  EvidenceFamily,
  Segment,
  VideoKey
} from "../../../core/plugin/types";
import type { AnalysisResult } from "../../../core/analysis/types";
import { isCompleteAnalysis } from "../../../core/analysis/completeness";
import {
  conversationWarnings,
  runConversation
} from "../../../core/analysis/conversation-runner";
import { evaluateSegments } from "../../../core/policy/policy";
import type { BiliClient } from "../api/client";
import { createBiliClient } from "../api/client";
import type { CacheStore } from "../../../core/ports/cache/store";
import { makeCacheKey } from "../../../core/ports/cache/store";
import type { LlmClient } from "../../../core/ports/llm/client";
import {
  buildSequentialChunks,
  buildSequentialChunksFromCues,
  type AnalysisChunk
} from "../../../core/analysis/planner";
import type { AnalysisServices, SegmentAnalyzer } from "../../../core/plugin/types";
import { deriveCandidates } from "./candidates";
import { createConversationSystem, parseRoundTable } from "./conversation";
import { buildEvidencePack } from "./evidence";
import { buildRoundUserMessage, effectivePromptVersion } from "./prompt";
import { splitAnalysisChunk } from "./chunk-split";
import type { SignalSet } from "./signals";
import { openSharedEvidence, pushWarning, sleepDefault } from "./evidence-loader";

interface AnalyzeInput {
  bvid: string;
  page: number;
  currentTime?: number;
}

export interface AnalyzeDeps {
  client: BiliClient;
  llm: LlmClient;
  cache: CacheStore;
  policy: AnalysisPolicy;
  promptVersion: string;
  model: string;
  /** 当前服务商是否自动按请求前缀缓存；决定对话历史全量保留还是压缩。 */
  prefixCache?: boolean;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 每完成一个分析分块回调一次，界面用它显示「已完成 n / m 块」。 */
  onProgress?: (done: number, total: number) => void;
  /** 连续对话每轮的增量结果（到此为止的完整片段表，整表替换）；片段引擎用它即时展示。 */
  onPartial?: (partial: AnalysisPartial) => void;
  /** 返回 true 时在下一个分块前停止分析，已完成的分块保留但不写缓存。 */
  isCancelled?: () => boolean;
  /** 取消信号：直接中断在途的 LLM 请求，而不只是等它跑完再丢弃结果。 */
  signal?: AbortSignal;
  /** 与主分析共用证据包时，按发起轮次归属；没有则退回本链自己的信号。 */
  evidenceSignal?: AbortSignal;
}

/** 证据族 -> 判定函数：新增一族只加一行，不用再补一个同构的 hasXxx 函数。 */
const FAMILY_CHECKS: Array<
  [EvidenceFamily, (segment: Segment, signals: SignalSet) => boolean]
> = [
  ["jump_coordinate", (segment, signals) =>
    signals.jumpTargets.some(
      (target) => target.votes >= 2 && Math.abs(target.time - segment.end) <= 10
    )],
  ["ad_word", (segment, signals) =>
    signals.adWordHits.filter(
      (hit) => hit.time >= segment.start - 5 && hit.time <= segment.end + 5
    ).length >= 2],
  ["divergent_term", (segment, signals) =>
    signals.divergentTerms.some((term) => {
      const center = (term.first + term.last) / 2;
      return center >= segment.start - 15 && center <= segment.end + 15;
    })],
  ["density", (segment, signals) =>
    signals.densitySpikes.some(
      (spike) => spike.end > segment.start && spike.start < segment.end
    )],
  ["chapter", (segment, signals) =>
    signals.chapterHits.some((hit) => hit.end > segment.start && hit.start < segment.end)],
  ["transcript", (segment, signals) =>
    signals.ctaHits.some((hit) => hit.time >= segment.start - 3 && hit.time <= segment.end + 3)]
];

function familyFor(segment: Segment, signals: SignalSet): EvidenceFamily[] {
  return FAMILY_CHECKS.filter(([, check]) => check(segment, signals)).map(
    ([family]) => family
  );
}

function attachFamilies(segments: Segment[], signals: SignalSet): Segment[] {
  return segments.map((segment) => ({
    ...segment,
    families: familyFor(segment, signals)
  }));
}

export async function analyzeVideo(
  input: AnalyzeInput,
  deps: AnalyzeDeps
): Promise<AnalysisResult> {
  const sleep = deps.sleep ?? sleepDefault;
  // 与决策分析器共享同一个证据包：站点请求与信号计算都只做一次。
  const bundle = openSharedEvidence(
    { bvid: input.bvid, page: input.page },
    {
      client: deps.client,
      sleep,
      ...((deps.evidenceSignal ?? deps.signal)
        ? { signal: deps.evidenceSignal ?? deps.signal }
        : {})
    }
  );
  const video = await bundle.video;
  // 结果与缓存的最终视频标识：partId 用 cid，多 P 之间互不命中。
  const resultVideoKey: VideoKey = {
    site: "bilibili",
    videoId: input.bvid,
    partId: String(video.cid)
  };
  const promptVersion = effectivePromptVersion(
    deps.promptVersion,
    deps.policy.kindPromptOverrides
  );
  const cacheKey = makeCacheKey({
    key: resultVideoKey,
    analyzerId: "bilibili",
    analyzerVersion: BILIBILI_ANALYZER_VERSION,
    model: deps.model,
    promptVersion
  });
  const cached = await deps.cache.get(cacheKey);
  // 全量结果不受登录态影响，命中即可返回，不必为了确认字幕再打一次播放器接口。
  if (cached && cached.result.mode === "full") return cached.result;

  // 登录态与是否存在字幕轨决定分析模式，必须先于缓存命中判定拿到。
  // 字幕与弹幕并行取；拿到字幕先看能不能复用仅弹幕缓存，再等信号算完。
  const evidence = await bundle.subtitle();
  // 仅弹幕缓存只在当前确实没有可用字幕正文时复用（没有轨道，或轨道正文为空）；
  // 登录后能读字幕就重新做全量。
  if (cached && (!evidence.hasSubtitleTrack || evidence.subtitleBodyEmpty)) {
    return cached.result;
  }

  const data = await bundle.collect();
  // 字幕与弹幕都没读到时没有任何可判证据：逐块发请求只会白烧配额，
  // 结果又因为没证据不进缓存，每次刷新都重来一遍。与决策管线的
  // no_context 短路口径一致，直接返回空结果。
  if (data.cues.length === 0 && data.danmaku.items.length === 0) {
    return {
      videoKey: cacheKey,
      video: resultVideoKey,
      mode: data.mode,
      segments: [],
      warnings: data.warnings,
      durationSec: data.video.duration
    };
  }
  // 连续对话必须从头按时间顺序读，不能按播放位置重排分块。
  // input.currentTime 只保留在入参里（插件契约），不再参与分析顺序。
  // 有台词时按台词长度取时间范围（6000 字符一块），台词零裁剪、弹幕与台词对齐；
  // 仅弹幕模式没有台词可驱动，退回 5 分钟等时切块。
  const chunks =
    data.cues.length > 0
      ? buildSequentialChunksFromCues(data.cues, data.video.duration)
      : buildSequentialChunks(data.video.duration);
  const system = createConversationSystem(deps.policy.kindPromptOverrides, data.video);
  // 候选窗口只由全片信号决定，与分块无关：循环外算一次，各块只做区间过滤。
  const allCandidates = deriveCandidates(data.signals, data.video.duration, 10);
  const batch = await runConversation<AnalysisChunk>({
    chunks,
    system,
    durationSec: data.video.duration,
    mode: data.mode,
    llm: deps.llm,
    splitChunk: splitAnalysisChunk,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.prefixCache !== undefined ? { prefixCache: deps.prefixCache } : {}),
    ...(deps.isCancelled ? { isCancelled: deps.isCancelled } : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    ...(deps.onPartial ? { onPartial: deps.onPartial } : {}),
    buildRoundPrompt: (round) => {
      const candidates = allCandidates.filter(
        (candidate) => candidate.end >= round.chunk.start && candidate.start <= round.chunk.end
      );
      const pack = buildEvidencePack({
        duration: data.video.duration,
        chunk: round.chunk,
        mode: data.mode,
        cues: data.cues,
        danmaku: data.danmaku.items,
        signals: data.signals,
        candidates
      });
      return buildRoundUserMessage(pack, {
        index: round.index,
        total: round.total,
        readUpTo: round.readUpTo,
        isLast: round.isLast
      });
    },
    parseRound: (text, round) =>
      parseRoundTable(text, data.video.duration, round.chunk.end),
    transformTable: (segments) => attachFamilies(segments, data.signals)
  });
  const warnings = [...data.warnings, ...conversationWarnings(batch)];

  // 模型给的就是权威整表：解析层已完成时长裁剪、去重、排序与闭合状态归一。
  // 这里不再做「同类型相邻就合并」，那会把模型明确分开的两段又粘回去。
  const merged = batch.segments;
  const hasDuration = data.video.duration > 0;
  if (!hasDuration) {
    pushWarning(warnings, {
      code: "partial",
      message: "无法确定视频时长，未做时间轴判定"
    });
  }
  // 未闭合片段永远不会自动跳，不该占用「自动跳覆盖率」的额度：
  // 否则一条还在读的广告就能把已定稿片段统统降级成只标记。
  const policyResult = evaluateSegments(
    merged.filter((segment) => segment.status !== "open"),
    data.video.duration,
    deps.policy,
    data.mode
  );
  if (policyResult.guardTriggered) {
    pushWarning(warnings, {
      code: "coverage_guard",
      message: "自动跳片段覆盖超过上限，本条视频全部改为只标记"
    });
  }

  const result: AnalysisResult = {
    videoKey: cacheKey,
    video: resultVideoKey,
    mode: data.mode,
    segments: merged,
    warnings,
    durationSec: data.video.duration
  };

  if (
    isCompleteAnalysis({
      durationSec: data.video.duration,
      cancelled: batch.cancelled,
      authFailed: batch.authFailed,
      failedChunks: batch.failedChunks,
      droppedChunks: batch.droppedChunks,
      hasEvidence: data.cues.length > 0 || data.danmaku.items.length > 0
    })
  ) {
    await deps.cache.set(cacheKey, { result, createdAt: deps.now() });
  }
  return result;
}

/**
 * 提示词版本，同时参与缓存键。
 * v4：证据按维度分块，坐标带弹幕位置高频区间，新增内容边界句，候选窗口给组成项；
 *     视频信息移入 system，分块改为按台词长度取时间范围。
 */
export const PROMPT_VERSION = "v4";
/**
 * 分析器实现版本（缓存键 analyzerVersion 段）。
 * 4：一个视频一个连续对话，整表可修订；有台词时按台词长度累计分块，
 *     仅弹幕模式仍按 5 分钟等时。时长来源改动后旧版本的缓存不能复用。
 */
const BILIBILI_ANALYZER_VERSION = "4";

/** 插件契约入口：把哔哩哔哩分析器包装成通用 SegmentAnalyzer。 */
export function createBilibiliSegmentAnalyzer(services: AnalysisServices): SegmentAnalyzer {
  return {
    async analyze(run) {
      const settings = await services.readSettings();
      return analyzeVideo(
        {
          bvid: run.video.videoId,
          // partId 由适配器保证是分 P 序号；不给兜底值——getVideo 对不存在的
          // 分 P 会显式报错，静默落到第 1 页会把结果写到错误的时间轴。
          page: Number(run.video.partId),
          currentTime: run.currentTime
        },
        {
          client: createBiliClient(fetch),
          llm: services.llm,
          cache: services.cache,
          policy: settings.policy,
          promptVersion: PROMPT_VERSION,
          model: settings.model ?? "unknown",
          prefixCache: settings.llmPrefixCache === true,
          now: Date.now,
          onProgress: run.onProgress,
          onPartial: run.onPartial,
          isCancelled: run.isCancelled,
          signal: run.signal,
          ...(run.evidenceSignal ? { evidenceSignal: run.evidenceSignal } : {})
        }
      );
    }
  };
}
