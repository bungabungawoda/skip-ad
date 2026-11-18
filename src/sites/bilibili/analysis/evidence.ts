import type { AnalysisMode, DanmakuItem, SubtitleCue } from "../types";
import type { AnalysisChunk } from "../../../core/analysis/planner";
import { CHUNK_CHARS_DEFAULT } from "../../../core/lib/limits";
import type { CandidateWindow } from "./candidates";
import type {
  BoundaryHit,
  CueHint,
  DivergentTerm,
  JumpTarget,
  PhraseHit,
  SignalSet
} from "./signals";
import { AD_WORDS } from "./signals";
import { lastCueEnd } from "../api/subtitle";

interface EvidenceCoverage {
  /** 本段弹幕总数，裁剪前。 */
  danmakuTotal: number;
  /** 实际发给模型的弹幕数。 */
  danmakuShown: number;
  /** 本段台词总字数，裁剪前。 */
  cueCharsTotal: number;
  /** 实际发给模型的台词字数。 */
  cueCharsShown: number;
}

/**
 * 一个分块发给模型的证据。
 * 标题、UP 主、简介、章节这类整条视频不变的信息不在这里：
 * 它们拼进 system 提示词只发一份，不随每轮重复。
 */
export interface EvidencePack {
  duration: number;
  chunk: AnalysisChunk;
  mode: AnalysisMode;
  /** 字幕里结束最晚的那一句；0 表示没有字幕。提示词用它说明台词到哪结束。 */
  subtitleEnd: number;
  candidates: CandidateWindow[];
  cues: SubtitleCue[];
  danmaku: DanmakuItem[];
  jumpTargets: JumpTarget[];
  boundaries: BoundaryHit[];
  adWordHits: PhraseHit[];
  divergentTerms: DivergentTerm[];
  ctaHits: PhraseHit[];
  coverage: EvidenceCoverage;
}

interface EvidenceInput {
  /** 本分块用到的正片时长口径；与缓存、覆盖率守卫同源。 */
  duration: number;
  chunk: AnalysisChunk;
  mode: AnalysisMode;
  cues: SubtitleCue[];
  danmaku: DanmakuItem[];
  signals: SignalSet;
  candidates: CandidateWindow[];
}

const MAX_CUE_CHARS = CHUNK_CHARS_DEFAULT;
const MAX_DANMAKU = 400;
/** 弹幕聚合的桶宽；提示词里的时间头用同一常量（唯一来源）。 */
export const DANMAKU_BUCKET_SECONDS = 5;
const MAX_SAME_TEXT_PER_BUCKET = 3;
/** 坐标/边界之后多少秒内还有台词，就把它当成「这里在讲什么」的参照。 */
const CUE_HINT_AFTER = 6;
/** 目标落在两句台词之间时，向前找多久。 */
const CUE_HINT_BEFORE = 3;

/**
 * 取目标时间处、或之后最近的台词。
 * 坐标是主张，台词是事实：把两行放在一起，模型才能判断坐标落点是否合理。
 *
 * 台词按起点有序时用二分定位（见 createCueFinder）；坐标与边界句加起来可能上百个，
 * 每个都全表扫一遍是纯浪费。数组无序时退回线性查找，语义完全一致。
 */
function nearestCueLinear(cues: SubtitleCue[], time: number): CueHint | undefined {
  const containing = cues.find((cue) => cue.start <= time && time <= cue.end);
  if (containing) return { start: containing.start, text: containing.text };
  const next = cues.find((cue) => cue.start > time && cue.start - time <= CUE_HINT_AFTER);
  if (next) return { start: next.start, text: next.text };
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue && cue.end < time && time - cue.end <= CUE_HINT_BEFORE) {
      return { start: cue.start, text: cue.text };
    }
  }
  return undefined;
}

function sortedByStart(cues: SubtitleCue[]): boolean {
  for (let index = 1; index < cues.length; index += 1) {
    if ((cues[index - 1]?.start ?? 0) > (cues[index]?.start ?? 0)) return false;
  }
  return true;
}

/** 为一个分块准备一次「找附近台词」的查找器：前缀最大结束时间 + 二分。 */
function createCueFinder(cues: SubtitleCue[]): (time: number) => CueHint | undefined {
  if (!sortedByStart(cues)) return (time) => nearestCueLinear(cues, time);
  // maxEnd[i] 是 cues[0..i] 里最晚的结束时间：回扫时用它判断「更早的还有没有可能覆盖」。
  const maxEnd: number[] = new Array(cues.length);
  let running = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < cues.length; index += 1) {
    running = Math.max(running, cues[index]?.end ?? Number.NEGATIVE_INFINITY);
    maxEnd[index] = running;
  }

  const firstWithMaxEndAtLeast = (value: number): number => {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((maxEnd[mid] ?? Number.NEGATIVE_INFINITY) < value) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  /** 第一条起点在 time 之后的台词下标。 */
  const firstStartingAfter = (time: number): number => {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((cues[mid]?.start ?? 0) <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  return (time) => {
    const after = firstStartingAfter(time);
    // 覆盖 time 的台词：从 after-1 往回找，取下标最小的那条（与 find 的顺序一致）。
    let earliest = -1;
    for (let index = after - 1; index >= 0; index -= 1) {
      if ((maxEnd[index] ?? Number.NEGATIVE_INFINITY) < time) break;
      const cue = cues[index];
      if (cue && cue.start <= time && time <= cue.end) earliest = index;
    }
    if (earliest >= 0) {
      const cue = cues[earliest];
      if (cue) return { start: cue.start, text: cue.text };
    }
    const next = cues[after];
    if (next && next.start > time && next.start - time <= CUE_HINT_AFTER) {
      return { start: next.start, text: next.text };
    }
    // 之前最近的一条：从 after-1 往回，取结束时间落在 3 秒内、下标最大的那条。
    const start = firstWithMaxEndAtLeast(time - CUE_HINT_BEFORE);
    for (let index = after - 1; index >= start; index -= 1) {
      const cue = cues[index];
      if (cue && cue.end < time && time - cue.end <= CUE_HINT_BEFORE) {
        return { start: cue.start, text: cue.text };
      }
    }
    return undefined;
  };
}

function within(time: number, start: number, end: number, pad = 0): boolean {
  return time >= start - pad && time <= end + pad;
}

function nearCandidate(time: number, candidates: CandidateWindow[], pad = 5): boolean {
  return candidates.some((candidate) => within(time, candidate.start, candidate.end, pad));
}

function clipCues(
  cues: SubtitleCue[],
  candidates: CandidateWindow[],
  maxChars: number
): SubtitleCue[] {
  const total = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  if (total <= maxChars) return cues;

  // 按对象身份去重：同一个起点的多句台词（重叠字幕）都要保留，
  // 不能拿 cue.start 当键，否则后一句会被前一句吞掉。
  const selected = new Set<SubtitleCue>();
  let used = 0;
  const add = (cue: SubtitleCue): void => {
    if (selected.has(cue)) return;
    // 第一条再长也要发出去：整块台词被裁空比超预算更糟。
    if (selected.size > 0 && used + cue.text.length > maxChars) return;
    selected.add(cue);
    used += cue.text.length;
  };

  cues
    .filter((cue) => nearCandidate(cue.start, candidates))
    .forEach((cue) => add(cue));
  for (const cue of cues) add(cue);
  return [...selected].sort((a, b) => a.start - b.start);
}

function isPriorityDanmaku(item: DanmakuItem): boolean {
  const text = item.text.toLowerCase();
  return AD_WORDS.some((word) => text.includes(word.toLowerCase()));
}

/**
 * 同一个 5 秒窗口里，同一句话出现超过 3 次只留一条，并把次数记在 count 上。
 * 刷屏弹幕（「你被骗了」一个窗口 17 条）会把同窗口的其他弹幕挤出提示词，
 * 留下次数就够了，模型不需要看 17 遍同一句话。
 */
function dedupeDanmaku(items: DanmakuItem[]): DanmakuItem[] {
  const groups = new Map<string, DanmakuItem[]>();
  for (const item of items) {
    const bucket = Math.floor(item.time / DANMAKU_BUCKET_SECONDS) * DANMAKU_BUCKET_SECONDS;
    const key = `${bucket}:${item.text}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const out: DanmakuItem[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    if (group.length > MAX_SAME_TEXT_PER_BUCKET) {
      out.push({ ...first, count: group.length });
    } else {
      out.push(...group);
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** 按均匀间隔取 count 条，保证整段都有覆盖。 */
function uniformSample(items: DanmakuItem[], count: number): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  const step = items.length / Math.max(1, count);
  for (let index = 0; index < count; index += 1) {
    const item = items[Math.floor(index * step)];
    if (item) out.push(item);
  }
  return out;
}

function clipDanmaku(items: DanmakuItem[], maxCount: number): DanmakuItem[] {
  const deduped = dedupeDanmaku(items);
  if (deduped.length <= maxCount) return deduped;
  const byCount = (a: DanmakuItem, b: DanmakuItem): number =>
    (b.count ?? 1) - (a.count ?? 1) || a.time - b.time;

  // 第一优先：含广告词的，最多占 120 个名额；同组里出现次数高的先留。
  const priority = deduped
    .filter(isPriorityDanmaku)
    .sort(byCount)
    .slice(0, Math.min(maxCount, 120));
  const selected = [...priority];
  const used = new Set(selected);
  let remaining = maxCount - selected.length;

  // 第二优先：同窗口重复过的（count > 1），按出现次数从高到低。
  const repeated = deduped
    .filter((item) => !used.has(item) && (item.count ?? 1) > 1)
    .sort(byCount)
    .slice(0, remaining);
  selected.push(...repeated);
  for (const item of repeated) used.add(item);
  remaining = maxCount - selected.length;

  // 剩下的名额按均匀间隔补齐，保证整段都有覆盖。
  const rest = deduped.filter((item) => !used.has(item));
  selected.push(...uniformSample(rest, remaining));
  return selected.sort((a, b) => a.time - b.time);
}

export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const { chunk, candidates } = input;
  // 非最后一块右开：边界时刻与边界台词归属下一块，相邻两轮不丢不重；
  // 最后一块右闭，结尾前的弹幕全部归入。
  const inChunk =
    chunk.end >= input.duration
      ? (time: number): boolean => within(time, chunk.start, chunk.end)
      : (time: number): boolean => time >= chunk.start && time < chunk.end;
  // 候选窗口只要与分块有交集就要保留：按 candidate.end 过滤会吞掉跨分块边界的长窗口。
  const candidateOverlap = (candidate: CandidateWindow): boolean =>
    candidate.start <= chunk.end && candidate.end >= chunk.start;

  // 按分块器给出的台词组取，不按时间重筛：同起点台词的时间区间会互相覆盖，
  // 重筛会把后一组整组漏掉，模型永远看不到那批台词。
  const nearest = createCueFinder(input.cues);
  const chunkCues = chunk.cues ?? input.cues.filter((cue) => inChunk(cue.start));
  const shownCues = clipCues(
    chunkCues,
    candidates.filter(candidateOverlap),
    MAX_CUE_CHARS
  );
  const chunkDanmaku = input.danmaku.filter((item) => inChunk(item.time));
  const shownDanmaku = clipDanmaku(chunkDanmaku, MAX_DANMAKU);
  // 台词提示从完整字幕里取，避免目标附近的台词先被字符预算裁掉。
  const jumpTargets = input.signals.jumpTargets
    .filter((target) => inChunk(target.time))
    .map((target) => ({ ...target, cueHint: nearest(target.time) }));
  const boundaries = input.signals.boundaries
    .filter((hit) => inChunk(hit.time))
    .map((hit) => ({ ...hit, cueHint: nearest(hit.time) }));

  return {
    duration: input.duration,
    chunk,
    mode: input.mode,
    subtitleEnd: lastCueEnd(input.cues),
    candidates: candidates.filter(candidateOverlap),
    cues: shownCues,
    danmaku: shownDanmaku,
    jumpTargets,
    boundaries,
    adWordHits: input.signals.adWordHits.filter((hit) => inChunk(hit.time)),
    divergentTerms: input.signals.divergentTerms.filter((term) =>
      inChunk((term.first + term.last) / 2)
    ),
    ctaHits: input.signals.ctaHits.filter((hit) => inChunk(hit.time)),
    coverage: {
      danmakuTotal: chunkDanmaku.length,
      danmakuShown: shownDanmaku.length,
      cueCharsTotal: chunkCues.reduce((sum, cue) => sum + cue.text.length, 0),
      cueCharsShown: shownCues.reduce((sum, cue) => sum + cue.text.length, 0)
    }
  };
}
