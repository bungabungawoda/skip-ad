import type { Segment } from "../plugin/types";
import type { AnalysisMode, AnalysisPolicy } from "../analysis/types";
import { evaluateSegments, resolveOverlapsByKindOrder } from "../policy/policy";
import { segmentKey, type SkipSegment } from "../player/segment-skipper";
import type { UiSegmentView } from "./state";
import { t } from "../i18n";

interface SessionPolicyInput {
  segments: Segment[];
  policy: AnalysisPolicy;
  mode: AnalysisMode;
  /**
   * 本次分析使用的分 P 时长。播放器读到的 duration 不参与判定：
   * 后台写缓存、内容脚本展示、覆盖率守卫必须是同一个数。
   */
  durationSec: number;
  /** 「不是广告」标记，按 segmentKey 过滤。 */
  ignoredKeys: Set<string>;
}

interface SessionPolicyDecision {
  /** 展示视图：不含被优先级淘汰与被策略 off 的片段。 */
  views: UiSegmentView[];
  /** 允许自动跳的片段。 */
  auto: SkipSegment[];
  /** 判定结果自相矛盾，不能照着执行；调用方按分析失败处理。 */
  invalid?: string;
}

/**
 * 内容脚本与 Popup 共用的策略判定入口。
 * 任何需要「哪些片段显示、哪些自动跳」的地方都走这里，避免各处口径漂移。
 *
 * 原则是「标记就要跳」：不被自动跳的片段不展示，免得用户看到标记却等不到跳转。
 *
 * - open 片段的 end 只是「已读边界」：按「读到视频结尾都是广告」处理，
 *   终点补成正片时长；如果因此整片都成了广告，是模型没给出真实结尾，
 *   判为分析失败，不展示也不跳。
 * - 自动跳总时长超过上限时，不逐段标记，改为一条覆盖全片的标记并自动跳到结尾。
 * - 时长未知时没法确定终点，整段都不展示、不自动跳。
 */
export function evaluateSessionPolicy(input: SessionPolicyInput): SessionPolicyDecision {
  const visible = input.segments.filter(
    (segment) => !input.ignoredKeys.has(segmentKey(segment))
  );

  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    return { views: [], auto: [], invalid: t("ui.invalid.duration") };
  }
  const duration = input.durationSec;

  const hasOpenSegment = visible.some((segment) => segment.status === "open");

  // open 的终点是「读到之处」，按「直到视频结尾都是广告」补齐；key 保持原样，
  // 这样「不是广告」标记与命令仍然指向原始片段。终点超过正片时长的片段也要截到
  // 时长：否则重叠裁剪会把它们当成 0 宽丢掉，60% 上限守卫就永远不触发。
  const finalized = visible.map((segment) => {
    const end = Math.min(duration, segment.status === "open" ? duration : segment.end);
    return {
      segment:
        end !== segment.end || segment.status === "open"
          ? { ...segment, end, status: "closed" as const }
          : segment,
      key: segmentKey(segment)
    };
  });
  const resolved = resolveOverlapsByKindOrder(
    finalized.map((item) => item.segment),
    input.policy.kindOrder
  );

  /** 裁剪块只是原片段的一部分：按类型和区间包含关系找回原始身份。 */
  const originalKeyOf = (segment: Segment): string => {
    const source = finalized.find(
      (item) =>
        item.segment.kind === segment.kind &&
        item.segment.start <= segment.start &&
        item.segment.end >= segment.end
    );
    return source?.key ?? segmentKey(segment);
  };

  const policyResult = evaluateSegments(resolved, duration, input.policy, input.mode);
  if (policyResult.guardTriggered) {
    // 开放片段补到结尾后才铺满全片：模型没给出真实结尾，判定结果不可执行。
    if (hasOpenSegment) {
      return { views: [], auto: [], invalid: t("ui.invalid.missingEnd") };
    }
    // 片段铺满全片：一条「整片广告」标记，直接跳到结尾。类型取耗时最长的那段，
    // 让进度条颜色与列表标签跟原来的广告一致。
    const dominant = policyResult.auto.reduce<Segment | null>(
      (best, segment) =>
        !best || segment.end - segment.start > best.end - best.start ? segment : best,
      null
    );
    const whole: Segment = {
      start: 0,
      end: duration,
      kind: dominant?.kind ?? "unknown",
      confidence: 1,
      evidence: [],
      reason: t("ui.wholeVideoReason")
    };
    const key = "0.00-" + duration.toFixed(2);
    return {
      views: [{ segment: whole, policy: "auto", key }],
      auto: [{ start: 0, end: duration, key }]
    };
  }

  // 只展示会真正自动跳的片段：被判成「只标记」的片段不出现在界面里。
  const views: UiSegmentView[] = policyResult.auto.map((segment) => ({
    segment,
    policy: "auto",
    key: originalKeyOf(segment)
  }));
  views.sort((a, b) => a.segment.start - b.segment.start || a.segment.end - b.segment.end);
  return {
    views,
    auto: policyResult.auto.map((segment) => ({
      start: segment.start,
      end: segment.end,
      key: originalKeyOf(segment)
    }))
  };
}
