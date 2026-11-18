import type { Segment } from "../plugin/types";
import { SEGMENT_GAP_SECONDS } from "../lib/limits";

export interface SkipSegment {
  start: number;
  end: number;
  key: string;
}

export interface SkipState {
  lastTime: number;
  guardUntil: number;
  /** 起点为 0 的片段在回拖后的短暂抑制；普通撤销不再使用固定时长。 */
  suppressedUntil: Record<string, number>;
  skipped: Record<string, true>;
  /**
   * 起点为 0 的片段的「武装」痕迹：回拖到 0 重新武装时设置。
   * start=0 的片段没有「起点之前」可跨越，普通的 lastTime 判断
   * 无法与「开场就在片段中间」区分，靠这个字段表达「用户声明了重看」。
   */
  armedZeroStart: Record<string, true>;
}

interface PlaybackObservation {
  currentTime: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  /**
   * 播放器处于平台广告或状态未知时为 true：此时 duration 与 currentTime
   * 可能描述广告而不是正片，正片片段执行整体暂停，只同步 lastTime。
   */
  suspended?: boolean;
  now: number;
}

type SkipAction =
  | { type: "none" }
  | {
      type: "seek";
      to: number;
      /** 触发这次跳转的第一段：Toast 按它显示；撤销回到跳转前记录的位置。 */
      segment: SkipSegment;
      /** 本次跳转一并跨过的全部片段；失败回滚要按整组清，不能只清第一段。 */
      keys: string[];
      reason: "skip" | "undo";
    };

export interface SkipStep {
  state: SkipState;
  action: SkipAction;
}

export function segmentKey(segment: Pick<Segment, "start" | "end">): string {
  return `${segment.start.toFixed(2)}-${segment.end.toFixed(2)}`;
}

export function toSkipSegment(segment: Segment): SkipSegment {
  return { start: segment.start, end: segment.end, key: segmentKey(segment) };
}

export function createSkipState(initialTime = 0): SkipState {
  return {
    lastTime: Number.isFinite(initialTime) ? initialTime : 0,
    guardUntil: 0,
    suppressedUntil: {},
    skipped: {},
    armedZeroStart: {}
  };
}

function withLastTime(state: SkipState, time: number): SkipState {
  return { ...state, lastTime: time };
}

function isSuppressed(state: SkipState, key: string, now: number): boolean {
  const until = state.suppressedUntil[key] ?? 0;
  return until > now;
}

/** 倒回片段起点前多少秒算「重新观看」：重新武装自动跳，允许重看后再次跳过。 */
const REARM_MARGIN_SECONDS = 1;

/**
 * 起点为 0 的片段重新武装后的短暂抑制：拖回后的第一包位置报告不是自然播放，
 * 不能把它当成「自然播放进入片头」立刻弹到片段结尾。
 * 一包 timeupdate 约 250ms，窗口盖住第一包即可，不拖到第二包。
 */
const REWIND_SUPPRESS_MS = 250;

/**
 * 播放位置回到片段起点之前时清掉 skipped 标记。
 * 否则一次自动跳之后，用户拖回开头重看，就再也不会跳了。
 * 起点为 0 的片段没有「起点之前」：拖回 0 本身就算重新观看。
 */
function rearmSkipped(
  state: SkipState,
  segments: SkipSegment[],
  currentTime: number
): SkipState {
  let skipped: Record<string, true> | null = null;
  for (const segment of segments) {
    if (!state.skipped[segment.key]) continue;
    if (segment.start === 0 ? currentTime > 0 : currentTime > segment.start - REARM_MARGIN_SECONDS) {
      continue;
    }
    skipped ??= { ...state.skipped };
    delete skipped[segment.key];
  }
  return skipped ? { ...state, skipped } : state;
}

/**
 * start=0 片段的跨越判定：两个来源算「进入片头」——
 * - 开场就在起点（lastTime <= 0）：正片还没被消费过；
 * - 回拖到 0 重新武装（armedZeroStart）：用户声明了重看。
 * 开场在片段中间、或拖到片段中间都不满足：不弹开。
 */
function crossesStart(state: SkipState, segment: SkipSegment, currentTime: number): boolean {
  if (segment.start > 0) return state.lastTime < segment.start && currentTime >= segment.start;
  return currentTime > 0 && (state.lastTime <= 0 || !!state.armedZeroStart[segment.key]);
}

function findCrossingSegment(
  state: SkipState,
  segments: SkipSegment[],
  currentTime: number,
  now: number
): SkipSegment | undefined {
  return segments.find((segment) => {
    if (!crossesStart(state, segment, currentTime)) return false;
    if (state.skipped[segment.key] || isSuppressed(state, segment.key, now)) return false;
    return true;
  });
}

/** 给全部起点为 0 的片段设置武装痕迹：用户回拖到 0 声明了重看。 */
function armZeroStart(
  armed: SkipState["armedZeroStart"],
  segments: SkipSegment[]
): SkipState["armedZeroStart"] {
  const next = { ...armed };
  for (const segment of segments) {
    if (segment.start === 0) next[segment.key] = true;
  }
  return next;
}

/** 拖动落点不在起点：作废全部起点为 0 的片段武装痕迹。 */
function disarmZeroStart(
  armed: SkipState["armedZeroStart"],
  segments: SkipSegment[]
): SkipState["armedZeroStart"] {
  if (Object.keys(armed).length === 0) return armed;
  const next = { ...armed };
  for (const segment of segments) {
    if (segment.start === 0) delete next[segment.key];
  }
  return next;
}

/** 给全部起点为 0 的片段设一段短暂抑制，吸收回拖后的第一包位置报告。 */
function suppressAtZeroStart(
  suppressed: SkipState["suppressedUntil"],
  segments: SkipSegment[],
  now: number
): SkipState["suppressedUntil"] {
  const next = { ...suppressed };
  for (const segment of segments) {
    if (segment.start === 0) next[segment.key] = now + REWIND_SUPPRESS_MS;
  }
  return next;
}

/** 落点之后这么近的下一段并进同一次跳转：中间的空隙本来也不是正片。 */
const CHAIN_GAP_SECONDS = SEGMENT_GAP_SECONDS;
/** 自动跳之后的保护窗口，只用来吸收 seek 过程中迟到的事件。 */
const AUTO_SKIP_GUARD_MS = 300;

/**
 * 把落点向后扩到所有「起点在落点附近、终点比落点更远」的片段。
 * 否则跳到 A 的结尾会停在 B 的中间：B 的起点已经被越过，
 * 跨越判定（lastTime < start <= currentTime）再也不会成立，B 就永久漏跳。
 * 跨类型的相邻片段也走这里——合并只在同类型之间做，跳转必须能连跳。
 */
function extendSkipTarget(
  state: SkipState,
  segments: SkipSegment[],
  first: SkipSegment,
  duration: number,
  now: number
): { to: number; keys: string[] } {
  const keys = [first.key];
  let to = Math.min(duration, first.end + 0.05);
  let extended = true;
  while (extended) {
    extended = false;
    for (const segment of segments) {
      if (keys.includes(segment.key)) continue;
      if (state.skipped[segment.key] || isSuppressed(state, segment.key, now)) continue;
      if (segment.start > to + CHAIN_GAP_SECONDS) continue;
      const end = Math.min(duration, segment.end + 0.05);
      if (end <= to) continue;
      to = end;
      keys.push(segment.key);
      extended = true;
    }
  }
  return { to, keys };
}

export function observePlayback(
  state: SkipState,
  observation: PlaybackObservation,
  segments: SkipSegment[]
): SkipStep {
  const { currentTime, duration, paused, seeking, suspended, now } = observation;
  if (!Number.isFinite(currentTime)) return { state, action: { type: "none" } };
  if (paused || seeking || suspended === true) {
    return { state: withLastTime(state, currentTime), action: { type: "none" } };
  }
  if (now < state.guardUntil) {
    // 保护窗口里不同步 lastTime：同步会把「落点到下一段起点」这段跨越抹掉，
    // 窗口一过 lastTime 已经越过下一段起点，那一段就永远不跳了。
    return { state, action: { type: "none" } };
  }

  const delta = currentTime - state.lastTime;
  if (delta < 0 || delta > SEGMENT_GAP_SECONDS) {
    // 用户回拖时也要重新武装：大跨度回拖走这条分支，不走到下面的正常路径。
    // 否则拖回片段起点之前，skipped 标记还在，重看不会再跳。
    // 拖动中的位置报告由上方的 seeking 分支拦住；拖定之后的第一包就是自然播放。
    const next = withLastTime(state, currentTime);
    const rearmed = rearmSkipped(next, segments, currentTime);
    // 起点为 0 的片段：拖回起点（currentTime <= 0）设置武装痕迹 + 短暂抑制，
    // 痕迹让后续自然播放能被判定为跨越，抑制拦住回拖后的第一包——
    // 它不是自然播放，不拦的话拖回 0 的下一包立刻把用户弹到片段结尾。
    // 拖到别处（片段内或片段外）则清掉旧痕迹：武装只对「贴着起点」有效，
    // 残留会让之后拖回片段内部的自然播放被误弹。
    const rewoundToStart = rearmed !== next && currentTime <= 0;
    const rearmedState = rewoundToStart
      ? { ...rearmed, armedZeroStart: armZeroStart(rearmed.armedZeroStart, segments) }
      : { ...rearmed, armedZeroStart: disarmZeroStart(rearmed.armedZeroStart, segments) };
    return {
      state: rewoundToStart
        ? {
            ...rearmedState,
            suppressedUntil: suppressAtZeroStart(
              rearmedState.suppressedUntil,
              segments,
              now
            )
          }
        : rearmedState,
      action: { type: "none" }
    };
  }

  // 先按当前位置重新武装，再判断是否跨过起点：两处必须用同一份状态。
  const armed = rearmSkipped(state, segments, currentTime);
  const segment = findCrossingSegment(armed, segments, currentTime, now);
  if (!segment) return { state: withLastTime(armed, currentTime), action: { type: "none" } };

  const { to, keys } = extendSkipTarget(armed, segments, segment, duration, now);
  if (to <= currentTime) {
    return { state: withLastTime(armed, currentTime), action: { type: "none" } };
  }
  const skipped = { ...armed.skipped };
  for (const key of keys) skipped[key] = true;
  return {
    state: {
      ...armed,
      lastTime: to,
      guardUntil: now + AUTO_SKIP_GUARD_MS,
      skipped
    },
    action: { type: "seek", to, segment, keys, reason: "skip" }
  };
}

/**
 * 撤销：回到这次跳转发生前记录的位置。
 * `to` 缺省时退回片段起点，兼容只关心状态、不传落点的调用。
 */
export function undoSkip(
  state: SkipState,
  segment: SkipSegment,
  now: number,
  to = Math.max(0, segment.start + 0.01)
): SkipStep {
  const target = Math.max(0, to);
  return {
    state: {
      ...state,
      lastTime: target,
      guardUntil: now + 1_000,
      // 撤销后本次播放不再自动跳这一段；拖回片段起点之前会由 rearmSkipped 清掉。
      skipped: { ...state.skipped, [segment.key]: true }
    },
    action: { type: "seek", to: target, segment, keys: [segment.key], reason: "undo" }
  };
}
