import { makeCacheKey } from "../../../core/ports/cache/store";
import type { AnalysisServices, SegmentAnalyzer } from "../../../core/plugin/types";
import type { AnalysisResult } from "../../../core/analysis/types";
import { analyzeTranscript } from "./transcript-analyzer";
import { effectivePromptVersion } from "../../../core/analysis/prompt-version";
import { logInfo, logWarn } from "../../../core/lib/log";
import { loadTranscript } from "../transcript";
import { buildTranscriptRoundPrompt, buildTranscriptSystemPrompt } from "./prompt";

/**
 * YouTube 字幕分析器：缓存 → 当前播放器字幕源 → 通用字幕分析流程（连续对话）。
 * 有可用 LLM 配置时打开视频即分析；无字幕只停用本能力，不影响平台广告跳过。
 */

/** 分析结果结构版本（YouTube 字幕流），参与缓存键。 */
const YOUTUBE_PROMPT_VERSION = "yt-v2";
/** 分析器实现版本（缓存键 analyzerVersion 段）。字幕源切换后必须升版。 */
const YOUTUBE_ANALYZER_VERSION = "5";

/** 只认核对过的正片时长；字幕结尾不等于视频结尾。 */
function trustedDuration(known: number | undefined): number {
  return typeof known === "number" && Number.isFinite(known) && known > 0 ? known : 0;
}

/** 无字幕/读不到时只认同一份字幕源给出的时长。 */
function fallbackDuration(transcript: { durationSec?: number }): number {
  return transcript.durationSec ?? 0;
}

export function createYouTubeSegmentAnalyzer(services: AnalysisServices): SegmentAnalyzer {
  return {
    async analyze(run) {
      const settings = await services.readSettings();
      const promptVersion = effectivePromptVersion(
        YOUTUBE_PROMPT_VERSION,
        settings.policy.kindPromptOverrides
      );
      const cacheKey = makeCacheKey({
        key: run.video,
        analyzerId: "youtube",
        analyzerVersion: YOUTUBE_ANALYZER_VERSION,
        model: settings.model ?? "unknown",
        promptVersion
      });
      // 5 分钟内按同一份证据处理；缓存命中时连字幕都不再读取。
      // CacheStore 的契约是不抛错（runtime-client 已兜底降级），直接信任。
      const cached = await services.cache.get(cacheKey);
      if (cached) return cached.result;

      const transcript = await loadTranscript(run.video.videoId, run.signal);
      if (transcript.kind !== "transcript") {
        const durationSec = fallbackDuration(transcript);

        if (transcript.kind === "no_transcript") {
          // 只有播放器桥明确返回空轨道才走到这里，这是对「当前视频没有字幕」的肯定判断。
          logInfo("YouTube 视频没有可用字幕", run.video.videoId);
          return {
            videoKey: "",
            video: run.video,
            mode: "full",
            segments: [],
            warnings: [
              { code: "subtitle_missing", message: "该视频没有可用字幕" },
              { code: "no_context", message: "该视频没有字幕，也没有弹幕" }
            ],
            durationSec
          } satisfies AnalysisResult;
        }

        if (transcript.kind === "player_data_unavailable") {
          // 读不到播放器数据不等于视频没有字幕；不写阴性缓存，界面提示重试。
          logWarn("YouTube 播放器字幕数据不可用", run.video.videoId, transcript.detail);
          return {
            videoKey: "",
            video: run.video,
            mode: "full",
            segments: [],
            warnings: [
              {
                code: "player_data_unavailable",
                message: `没有读到当前播放器的字幕数据：${transcript.detail}`
              }
            ],
            durationSec
          } satisfies AnalysisResult;
        }

        logWarn("YouTube 字幕读取失败", run.video.videoId, transcript.detail);
        return {
          videoKey: "",
          video: run.video,
          mode: "full",
          segments: [],
          warnings: [
            {
              code: "transcript_fetch_failed",
              message: `字幕读取失败：${transcript.detail}`
            }
          ],
          durationSec
        } satisfies AnalysisResult;
      }

      const durationSec = trustedDuration(transcript.durationSec);
      logInfo(
        "开始 YouTube 字幕分析",
        run.video.videoId,
        transcript.cues.length,
        "行",
        transcript.source
      );
      const result = await analyzeTranscript(
        {
          video: run.video,
          cues: transcript.cues,
          durationSec
        },
        {
          llm: services.llm,
          cache: services.cache,
          cacheKey,
          buildSystemPrompt: () =>
            buildTranscriptSystemPrompt(
              { video: run.video, durationSec },
              settings.policy.kindPromptOverrides
            ),
          buildRoundPrompt: (context) => buildTranscriptRoundPrompt(context),
          prefixCache: settings.llmPrefixCache === true,
          now: Date.now,
          signal: run.signal,
          isCancelled: run.isCancelled,
          onProgress: run.onProgress,
          onPartial: run.onPartial
        }
      );
      return result;
    }
  };
}
