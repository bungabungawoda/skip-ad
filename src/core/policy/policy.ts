import type { Segment, SegmentKind } from "../plugin/types";
import { SEGMENT_KINDS } from "../plugin/types";
import type { AnalysisMode, AnalysisPolicy, PolicyResult, SegmentPolicy } from "../analysis/types";
import { clamp, totalCoverage } from "../lib/time";
import { isRecord } from "../lib/record";

export const DEFAULT_POLICY: AnalysisPolicy = {
  perKind: {
    sponsor: "auto",
    insert: "auto",
    promo: "auto",
    self_promo: "auto",
    topic: "off",
    unknown: "mark"
  },
  kindOrder: [...SEGMENT_KINDS],
  confidenceThreshold: 0.7,
  maxAutoCoverage: 0.6,
  danmakuAutoEnabled: true
};

const SEGMENT_POLICIES: SegmentPolicy[] = ["auto", "mark", "off"];

function readFinite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/** 类型优先级规范化：剔除非法值、去重、补全缺失类型。UI 与策略存储共用。 */
export function normalizeKindOrder(raw: unknown): SegmentKind[] {
  if (!Array.isArray(raw)) return [...SEGMENT_KINDS];
  const order: SegmentKind[] = [];
  for (const value of raw) {
    if (typeof value === "string" && SEGMENT_KINDS.includes(value as SegmentKind)) {
      const kind = value as SegmentKind;
      if (!order.includes(kind)) order.push(kind);
    }
  }
  for (const kind of SEGMENT_KINDS) {
    if (!order.includes(kind)) order.push(kind);
  }
  return order;
}

export const KIND_PROMPT_MAX_LENGTH = 200;

/** 永不自动跳的类型：界面只允许「只标记 / 关闭」，存储与判定都要兜住。 */
const NEVER_AUTO: Partial<Record<SegmentKind, SegmentPolicy>> = {
  topic: "off",
  unknown: "mark"
};

/** 某类型在界面上可选的策略：永不自动跳的类型不出现 auto。 */
export function allowedPolicies(kind: SegmentKind): SegmentPolicy[] {
  return NEVER_AUTO[kind] ? ["mark", "off"] : [...SEGMENT_POLICIES];
}

function clampKindPolicy(kind: SegmentKind, value: SegmentPolicy): SegmentPolicy {
  const forced = NEVER_AUTO[kind];
  if (forced && value === "auto") return forced;
  return value;
}

/** 校验用户改写的类型描述：只留合法类型的非空文本，超长截断；全空时返回 undefined。 */
export function normalizeKindPromptOverrides(
  raw: unknown
): Partial<Record<SegmentKind, string>> | undefined {
  if (!isRecord(raw)) return undefined;
  const overrides: Partial<Record<SegmentKind, string>> = {};
  for (const kind of SEGMENT_KINDS) {
    const value = raw[kind];
    if (typeof value !== "string") continue;
    const text = value.trim().slice(0, KIND_PROMPT_MAX_LENGTH);
    if (text) overrides[kind] = text;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function normalizePolicy(raw: unknown): AnalysisPolicy {
  if (!isRecord(raw)) return { ...DEFAULT_POLICY, perKind: { ...DEFAULT_POLICY.perKind } };
  const perKind = { ...DEFAULT_POLICY.perKind };
  if (isRecord(raw.perKind)) {
    for (const kind of SEGMENT_KINDS) {
      const value = raw.perKind[kind];
      if (typeof value === "string" && SEGMENT_POLICIES.includes(value as SegmentPolicy)) {
        perKind[kind] = clampKindPolicy(kind, value as SegmentPolicy);
      }
    }
  }
  return {
    perKind,
    kindOrder: normalizeKindOrder(raw.kindOrder),
    kindPromptOverrides: normalizeKindPromptOverrides(raw.kindPromptOverrides),
    confidenceThreshold: readFinite(
      raw.confidenceThreshold,
      DEFAULT_POLICY.confidenceThreshold,
      0,
      1
    ),
    maxAutoCoverage: readFinite(
      raw.maxAutoCoverage,
      DEFAULT_POLICY.maxAutoCoverage,
      0.01,
      1
    ),
    danmakuAutoEnabled:
      typeof raw.danmakuAutoEnabled === "boolean"
        ? raw.danmakuAutoEnabled
        : DEFAULT_POLICY.danmakuAutoEnabled
  };
}

function policyForKind(policy: AnalysisPolicy, kind: SegmentKind): SegmentPolicy {
  return policy.perKind[kind];
}

function danmakuEvidencePass(segment: Segment): boolean {
  const families = new Set(segment.families ?? []);
  const strong = families.has("jump_coordinate") || families.has("ad_word");
  return families.size >= 3 && strong;
}

function classifySegment(
  segment: Segment,
  policy: AnalysisPolicy,
  mode: AnalysisMode
): SegmentPolicy {
  const modePolicy = clampKindPolicy(segment.kind, policyForKind(policy, segment.kind));
  if (modePolicy !== "auto") return modePolicy;
  const modeAllowsAuto = mode === "full" || policy.danmakuAutoEnabled;
  const passesEvidence = mode === "full" || danmakuEvidencePass(segment);
  if (modeAllowsAuto && passesEvidence && segment.confidence >= policy.confidenceThreshold) {
    return "auto";
  }
  return "mark";
}

export function evaluateSegments(
  segments: Segment[],
  duration: number,
  policy: AnalysisPolicy,
  mode: AnalysisMode
): PolicyResult {
  const autoCandidates: Segment[] = [];
  const mark: Segment[] = [];
  const off: Segment[] = [];

  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const decision = classifySegment(segment, policy, mode);
    if (decision === "off") off.push(segment);
    else if (decision === "auto") autoCandidates.push(segment);
    else mark.push(segment);
  }

  // 时长未知时 totalCoverage 恒为 0，守卫会形同失效；此时一律不放行自动跳。
  const coverage = totalCoverage(autoCandidates, duration);
  const guardTriggered =
    !Number.isFinite(duration) || duration <= 0 || coverage > policy.maxAutoCoverage;
  if (guardTriggered) {
    mark.push(...autoCandidates);
    return { auto: [], mark, off, coverage, guardTriggered };
  }
  return { auto: autoCandidates, mark, off, coverage, guardTriggered };
}


interface Interval {
  start: number;
  end: number;
}

/** 从 [start, end) 里扣掉 covers 覆盖的部分，返回剩下的区间。 */
function subtractIntervals(start: number, end: number, covers: Interval[]): Interval[] {
  const ordered = covers
    .filter((cover) => cover.end > start && cover.start < end)
    .sort((left, right) => left.start - right.start);
  const pieces: Interval[] = [];
  let cursor = start;
  for (const cover of ordered) {
    if (cover.start > cursor) pieces.push({ start: cursor, end: Math.min(cover.start, end) });
    cursor = Math.max(cursor, cover.end);
    if (cursor >= end) break;
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  // 裁剪剩下的残段全部保留：丢掉就等于这段时间既不标也不跳，覆盖统计里也不出现。
  return pieces.filter((piece) => piece.end - piece.start > 0);
}

/**
 * 同一时间命中多个不同类型的片段时，按 kindOrder 让排名靠前的类型占住重叠区：
 * 排名靠后的片段被裁成未重叠的剩余区间，而不是整条丢掉——
 * 一段 5 秒的商单盖住 60 秒带货时，剩下的 55 秒仍然是广告。
 * 同类型的重叠片段都保留（上游已经把同类型相邻的合并掉了）。
 */
export function resolveOverlapsByKindOrder(
  segments: Segment[],
  kindOrder: SegmentKind[]
): Segment[] {
  const rank = new Map<SegmentKind, number>();
  kindOrder.forEach((kind, index) => rank.set(kind, index));
  const rankOf = (kind: SegmentKind): number => rank.get(kind) ?? SEGMENT_KINDS.length;

  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Segment[] = [];
  for (const segment of sorted) {
    // 只有排名更靠前的类型能切掉这一段；排名靠前的片段自己永远不会被切，
    // 所以拿全部更强片段当覆盖区就够，不用关心处理顺序。
    const stronger = sorted.filter(
      (other) => other !== segment && rankOf(other.kind) < rankOf(segment.kind)
    );
    const pieces = subtractIntervals(segment.start, segment.end, stronger);
    for (const piece of pieces) {
      const uncut = piece.start === segment.start && piece.end === segment.end;
      kept.push(uncut ? segment : { ...segment, start: piece.start, end: piece.end });
    }
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}
