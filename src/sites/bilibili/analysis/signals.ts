import type { Chapter } from "../../../core/plugin/types";
import type { DanmakuItem, SubtitleCue } from "../types";

/**
 * 只放广告/付费推广本身的词。空降、跳过是跳转意图，由 JUMP_HINT 和边界句处理；
 * 放进这里会让「广告词命中」和「空降坐标」两个维度互相污染。
 */
export const AD_WORDS = [
  "广告",
  "恰饭",
  "广子",
  "赞助",
  "商单",
  "推广",
  "带货",
  "植入"
];

const CTA_PHRASES = [
  "赞助",
  "优惠",
  "折扣",
  "链接",
  "口令",
  "搜索",
  "下单",
  "购买",
  "小黄车",
  "橱窗",
  "评论区",
  "简介",
  "福利",
  "抽奖",
  "领券",
  "专属",
  "三连",
  "关注",
  "充电"
];

const CJK = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const CJK_RUN = new RegExp(`[${CJK}]+`, "g");
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9]{1,}|[0-9]{2,}[A-Za-z]+|[A-Za-z]+[0-9]+/g;
/**
 * 时间坐标要同时认 h:mm:ss 与 mm:ss。旧写法只允许一到两位分钟，
 * 遇到 1:05:30 会截成 1:05（65 秒）投错票，遇到 120:00 又整条漏掉。
 */
const TIME_WITH_HOURS = /(?<!\d)(\d{1,3})[:：](\d{1,2})[:：](\d{2})(?!\d)/g;
const TIME_MINUTES = /(?<!\d)(\d{1,3})[:：](\d{2})(?!\d)/g;

export interface CueHint {
  start: number;
  text: string;
}

export interface JumpTarget {
  time: number;
  votes: number;
  /** 最早、最晚的弹幕位置：说明观众是在广告里陆续发的，还是同一刻刷的。 */
  firstPosition?: number;
  lastPosition?: number;
  /** 弹幕位置按 3 秒分桶后票数最高的桶：多数投票观众当时看到的位置。 */
  modePosition?: { start: number; end: number; votes: number };
  /** 合并前目标时间的最小值与最大值；相差不到 1 秒时不必展示。 */
  targetMin?: number;
  targetMax?: number;
  /** 去重后的说法样例，最多 4 条。 */
  phrases?: string[];
  /** 目标附近的台词，由证据包按分块填充；没有字幕时不填。 */
  cueHint?: CueHint;
}

type BoundaryDirection = "content" | "ad";

export interface BoundaryHit {
  time: number;
  direction: BoundaryDirection;
  phrase: string;
  count: number;
  first: number;
  last: number;
  /** 边界附近的台词，由证据包填充。 */
  cueHint?: CueHint;
}

export interface PhraseHit {
  time: number;
  phrase: string;
  text: string;
}

export interface DivergentTerm {
  term: string;
  count: number;
  first: number;
  last: number;
  /** 命中的原始弹幕，最多 2 条；词表脱离原文，模型只能猜。 */
  samples: string[];
}

interface ChapterHit {
  start: number;
  end: number;
  title: string;
}

interface WindowTerms {
  start: number;
  end: number;
  terms: string[];
  share?: number;
}

interface DensityWindow {
  start: number;
  end: number;
  count: number;
}

export interface SignalSet {
  jumpTargets: JumpTarget[];
  adWordHits: PhraseHit[];
  divergentTerms: DivergentTerm[];
  ctaHits: PhraseHit[];
  chapterHits: ChapterHit[];
  novelty: WindowTerms[];
  repeat: WindowTerms[];
  /** 弹幕密度突增窗口，对应证据族 density。 */
  densitySpikes: DensityWindow[];
  /** 无秒数的边界句（正片开始、欢迎回来等），只作提示，不计入六类证据族。 */
  boundaries: BoundaryHit[];
}

interface SignalInput {
  title: string;
  description: string;
  duration: number;
  cues: SubtitleCue[];
  danmaku: DanmakuItem[];
  chapters: Chapter[];
}

/** 默认取 2–4 字词：2 字是「恰饭」「广告」这类短词，不能丢。 */
const GRAM_SIZES = [2, 3, 4];

/**
 * 逐个产出 n-gram，不建中间集合。
 * 弹幕信号里逐条调用它，每条弹幕建一个 Set 是这条链路上最贵的分配。
 */
function forEachGram(
  text: string,
  visit: (gram: string) => void,
  sizes: number[] = GRAM_SIZES
): void {
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0];
    for (const size of sizes) {
      if (run.length < size) continue;
      for (let index = 0; index + size <= run.length; index += 1) {
        visit(run.slice(index, index + size));
      }
    }
  }
  for (const match of text.matchAll(LATIN_TOKEN)) {
    visit(match[0].toLowerCase());
  }
}

function ngrams(text: string, sizes: number[] = GRAM_SIZES): Set<string> {
  const out = new Set<string>();
  forEachGram(text, (gram) => out.add(gram), sizes);
  return out;
}

function grams4(text: string): Set<string> {
  return new Set(
    [...ngrams(text, [4])].filter((term) => !/^[A-Za-z0-9]/.test(term) || term.length >= 3)
  );
}

function lowerIncludes(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase());
}

interface JumpVote {
  /** 弹幕挂在视频时间轴上的位置，通常就是观众发它时看到的地方；不是真实发送日期。 */
  position: number;
  target: number;
  text: string;
}

interface TimeMatch {
  index: number;
  end: number;
  target: number;
}

/**
 * 从一段弹幕里取出全部时间坐标。先认 h:mm:ss，再把已经占用的区间排除后认 mm:ss，
 * 避免 1:05:30 同时被解析成 3900 秒和 65 秒两个目标。
 */
function timeMatches(text: string): TimeMatch[] {
  const found: TimeMatch[] = [];
  for (const match of text.matchAll(TIME_WITH_HOURS)) {
    const index = match.index ?? 0;
    found.push({
      index,
      end: index + match[0].length,
      target: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    });
  }
  for (const match of text.matchAll(TIME_MINUTES)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    if (found.some((hit) => index < hit.end && end > hit.index)) continue;
    found.push({ index, end, target: Number(match[1]) * 60 + Number(match[2]) });
  }
  return found.sort((left, right) => left.index - right.index);
}

/** 明确指向「快进到这里」的措辞：这类弹幕常发在目标时间点附近，不能被自证过滤掉。 */
const JUMP_HINT = /空降|跳转|跳到|直达/;
/** 片头几秒内的坐标没有跳过价值，且容易误伤刚开始播放的用户。 */
const MIN_JUMP_TARGET = 5;
/** 后向坐标的容忍秒数。观众可能在目标前几秒发，回头指路的当普通弹幕。 */
const BACKWARD_TOLERANCE = 5;
/** 同一目标的合并半径。观众写的秒数常有 1–3 秒偏差。 */
const TARGET_MERGE_SECONDS = 3;
/** 单簇最大跨度，防止链式合并把两个边界并成一个。 */
const TARGET_MERGE_MAX_SPAN = 6;

function collectJumpVotes(danmaku: DanmakuItem[], duration: number): JumpVote[] {
  const votes: JumpVote[] = [];
  for (const item of danmaku) {
    const jumpHint = JUMP_HINT.test(item.text);
    for (const match of timeMatches(item.text)) {
      const target = match.target;
      if (target < MIN_JUMP_TARGET || target > duration) continue;
      // 回头指路的坐标不是跳过指令：观众已经过了目标，再跳回去只会打断正片。
      if (target < item.time - BACKWARD_TOLERANCE) continue;
      // 非「空降」类文本若坐标与弹幕位置相同，通常是在播报当前进度，而不是投坐标票。
      if (!jumpHint && Math.abs(target - item.time) <= 3) continue;
      votes.push({ position: item.time, target, text: item.text });
    }
  }
  return votes;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

/** 逐个比较取最小值；不用展开语法，簇大到几万票也不会碰到参数个数上限。 */
function minOf(values: number[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) if (value < min) min = value;
  return min;
}

function maxOf(values: number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value > max) max = value;
  return max;
}

/** 弹幕位置分桶的桶宽；与提示词里「高频位置」的时间粒度一致。 */
const POSITION_BUCKET_SECONDS = 3;

/**
 * 弹幕位置按 3 秒分桶，取票数最高的桶。
 * 中位数对分散分布没有解释力；高频桶直接指出多数投票观众当时看到的位置，
 * 它通常紧贴广告或片头起点。票数并列时取更早的桶，位置早的更贴近起点。
 */
function modePositionBucket(positions: number[]): JumpTarget["modePosition"] {
  if (positions.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const position of positions) {
    const bucket = Math.floor(position / POSITION_BUCKET_SECONDS);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  let best = Number.NaN;
  let bestCount = 0;
  for (const [bucket, count] of counts) {
    if (count > bestCount || (count === bestCount && bucket < best)) {
      best = bucket;
      bestCount = count;
    }
  }
  if (Number.isNaN(best)) return undefined;
  const start = best * POSITION_BUCKET_SECONDS;
  return { start, end: start + POSITION_BUCKET_SECONDS, votes: bestCount };
}

/**
 * 目标时间相近的票合并成一个簇。
 * 10:18、10:20、10:22 并成 10:20 左右的一簇；10:18 到 10:30 的链不会一路并到 10:40。
 */
function clusterVotes(votes: JumpVote[]): JumpVote[][] {
  const clusters: JumpVote[][] = [];
  for (const vote of [...votes].sort((a, b) => a.target - b.target)) {
    const current = clusters[clusters.length - 1];
    const last = current?.[current.length - 1];
    const first = current?.[0];
    if (
      current &&
      last &&
      first &&
      vote.target - last.target <= TARGET_MERGE_SECONDS &&
      vote.target - first.target <= TARGET_MERGE_MAX_SPAN
    ) {
      current.push(vote);
    } else {
      clusters.push([vote]);
    }
  }
  return clusters;
}

function uniquePhrases(votes: JumpVote[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const vote of [...votes].sort((a, b) => a.position - b.position)) {
    const text = vote.text.trim().slice(0, 40);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    phrases.push(text);
    if (phrases.length >= 4) break;
  }
  return phrases;
}

function toJumpTarget(votes: JumpVote[]): JumpTarget {
  const targets = votes.map((vote) => vote.target);
  const positions = votes.map((vote) => vote.position);
  return {
    time: median(targets),
    votes: votes.length,
    firstPosition: minOf(positions),
    lastPosition: maxOf(positions),
    modePosition: modePositionBucket(positions),
    targetMin: minOf(targets),
    targetMax: maxOf(targets),
    phrases: uniquePhrases(votes)
  };
}

function extractJumpTargets(
  danmaku: DanmakuItem[],
  duration: number
): JumpTarget[] {
  return clusterVotes(collectJumpVotes(danmaku, duration))
    .map(toJumpTarget)
    .sort((a, b) => b.votes - a.votes || a.time - b.time);
}

/**
 * 无秒数的边界句。观众在这些句子上不报时间，而是直接宣布「这里是边界」。
 * 方向只表示这句话站在哪一侧，不表示边界一定准确；是否广告仍由模型读台词判断。
 */
const BOUNDARY_PHRASES: ReadonlyArray<{
  phrase: string;
  direction: BoundaryDirection;
}> = [
  { phrase: "正片开始了", direction: "content" },
  { phrase: "正片开始", direction: "content" },
  { phrase: "欢迎回来", direction: "content" },
  { phrase: "空降成功", direction: "content" },
  { phrase: "广告结束", direction: "content" },
  { phrase: "广告时间到", direction: "content" },
  { phrase: "广告时间结束", direction: "content" },
  { phrase: "恰饭结束", direction: "content" },
  { phrase: "感谢指挥部", direction: "content" },
  { phrase: "广告开始", direction: "ad" },
  { phrase: "恰饭开始", direction: "ad" },
  { phrase: "广告时间", direction: "ad" },
  { phrase: "感谢甲方", direction: "ad" },
  { phrase: "0帧起手", direction: "ad" },
  { phrase: "零帧起手", direction: "ad" },
  { phrase: "金主爸爸", direction: "ad" }
];

const BOUNDARY_CLUSTER_SECONDS = 30;
const BOUNDARY_CLUSTER_MAX_SPAN = 45;

interface BoundaryOccurrence {
  time: number;
  phrase: string;
  direction: BoundaryDirection;
}

/** 一条弹幕可能同时命中「正片开始」和「正片开始了」，取最长的那个。 */
function matchBoundary(text: string): { phrase: string; direction: BoundaryDirection } | null {
  let best: { phrase: string; direction: BoundaryDirection } | null = null;
  for (const entry of BOUNDARY_PHRASES) {
    if (!text.includes(entry.phrase)) continue;
    if (!best || entry.phrase.length > best.phrase.length) best = entry;
  }
  return best;
}

function toBoundary(cluster: BoundaryOccurrence[]): BoundaryHit {
  const times = cluster.map((item) => item.time);
  const counts = new Map<string, number>();
  for (const item of cluster) counts.set(item.phrase, (counts.get(item.phrase) ?? 0) + 1);
  const phrase =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? "";
  return {
    time: median(times),
    direction: cluster[0]?.direction ?? "content",
    phrase,
    count: cluster.length,
    first: Math.min(...times),
    last: Math.max(...times)
  };
}

/**
 * 同一方向的边界句在 30 秒内聚成一簇。正片开始、欢迎回来、空降成功经常一起出现，
 * 按方向分别聚，避免两种方向的句子互相打断。
 */
function findBoundaries(danmaku: DanmakuItem[]): BoundaryHit[] {
  const occurrences: BoundaryOccurrence[] = [];
  for (const item of danmaku) {
    const match = matchBoundary(item.text);
    if (match) occurrences.push({ time: item.time, ...match });
  }
  const hits: BoundaryHit[] = [];
  for (const direction of ["content", "ad"] as const) {
    const list = occurrences
      .filter((item) => item.direction === direction)
      .sort((a, b) => a.time - b.time);
    let current: BoundaryOccurrence[] = [];
    const flush = (): void => {
      if (current.length > 0) hits.push(toBoundary(current));
      current = [];
    };
    for (const occurrence of list) {
      const last = current[current.length - 1];
      const first = current[0];
      if (
        last &&
        first &&
        occurrence.time - last.time <= BOUNDARY_CLUSTER_SECONDS &&
        occurrence.time - first.time <= BOUNDARY_CLUSTER_MAX_SPAN
      ) {
        current.push(occurrence);
      } else {
        flush();
        current = [occurrence];
      }
    }
    flush();
  }
  return hits.sort((a, b) => a.time - b.time);
}

function findPhraseHits<T>(
  items: T[],
  phrases: string[],
  textOf: (item: T) => string,
  timeOf: (item: T) => number
): PhraseHit[] {
  const hits: PhraseHit[] = [];
  const lowered = phrases.map((phrase) => phrase.toLowerCase());
  for (const item of items) {
    const text = textOf(item).toLowerCase();
    const index = lowered.findIndex((phrase) => text.includes(phrase));
    if (index >= 0) {
      hits.push({ time: timeOf(item), phrase: phrases[index] ?? "", text: textOf(item) });
    }
  }
  return hits.sort((a, b) => a.time - b.time);
}

const CHAPTER_HINTS = [...AD_WORDS, "合作", "福利", "三连", "关注", "充电"];

function findChapterHits(chapters: Chapter[]): ChapterHit[] {
  return chapters
    .filter((chapter) => CHAPTER_HINTS.some((word) => lowerIncludes(chapter.title, word)))
    .map((chapter) => ({ start: chapter.start, end: chapter.end, title: chapter.title }))
    .sort((a, b) => a.start - b.start);
}

/** 传入的 times 必须已按时间升序排好；调用方只排一次。 */
function concentrated(sorted: number[], maxSpan: number): boolean {
  if (sorted.length < 3) return false;
  let best = 0;
  for (let left = 0; left < sorted.length; left += 1) {
    let right = left;
    while (right < sorted.length && (sorted[right] ?? 0) <= (sorted[left] ?? 0) + maxSpan) {
      right += 1;
    }
    best = Math.max(best, right - left);
  }
  return best >= 0.8 * sorted.length;
}

interface TermOccurrence {
  times: number[];
  samples: string[];
  /** 最近一次登记的是哪条弹幕：同一条弹幕里的重复词只计一次。 */
  lastItem: number;
}

function viewerTermTimes(danmaku: DanmakuItem[]): Map<string, TermOccurrence> {
  const occurrences = new Map<string, TermOccurrence>();
  danmaku.forEach((item, index) => {
    const sample = item.text.trim().slice(0, 30);
    forEachGram(item.text, (gram) => {
      if (gram.length < 2) return;
      let entry = occurrences.get(gram);
      if (!entry) {
        entry = { times: [], samples: [], lastItem: -1 };
        occurrences.set(gram, entry);
      }
      if (entry.lastItem === index) return;
      entry.lastItem = index;
      entry.times.push(item.time);
      if (entry.samples.length < 2) entry.samples.push(sample);
    });
  });
  return occurrences;
}

function divergentCandidate(
  term: string,
  occurrence: TermOccurrence,
  maxSpan: number
): DivergentTerm | null {
  const { times } = occurrence;
  if (times.length < 3) return null;
  // 排序只做一次：集中度判断与首末时间用同一份结果。
  const sorted = [...times].sort((a, b) => a - b);
  if (!concentrated(sorted, maxSpan)) return null;
  return {
    term,
    count: times.length,
    first: sorted[0] ?? 0,
    last: sorted[sorted.length - 1] ?? 0,
    samples: occurrence.samples
  };
}

function dropSubstringTerms(candidates: DivergentTerm[]): DivergentTerm[] {
  const kept: DivergentTerm[] = [];
  for (const candidate of candidates) {
    if (
      kept.some(
        (item) => item.term.includes(candidate.term) || candidate.term.includes(item.term)
      )
    ) {
      continue;
    }
    kept.push(candidate);
    if (kept.length >= 20) break;
  }
  return kept;
}

function findDivergentTerms(
  cues: SubtitleCue[],
  danmaku: DanmakuItem[],
  maxSpan = 120
): DivergentTerm[] {
  const transcript = new Set<string>();
  for (const cue of cues) {
    for (const gram of ngrams(cue.text)) transcript.add(gram);
  }
  const candidates: DivergentTerm[] = [];
  for (const [term, occurrence] of viewerTermTimes(danmaku)) {
    if (transcript.has(term)) continue;
    const candidate = divergentCandidate(term, occurrence, maxSpan);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.count - a.count || b.term.length - a.term.length);
  return dropSubstringTerms(candidates);
}

function topicGrams(title: string, description: string): Set<string> {
  return new Set([...ngrams(title), ...ngrams(description)]);
}

function blockIndexes(cues: SubtitleCue[], start: number, end: number): number[] {
  const indexes: number[] = [];
  cues.forEach((cue, index) => {
    if (cue.start >= start && cue.start < end) indexes.push(index);
  });
  return indexes;
}

function insideGrams(
  cues: SubtitleCue[],
  cueGrams: Set<string>[],
  indexes: number[]
): Map<string, number> {
  const inside = new Map<string, number>();
  for (const index of indexes) {
    for (const gram of cueGrams[index] ?? []) {
      inside.set(gram, (inside.get(gram) ?? 0) + 1);
    }
  }
  return inside;
}

/** 全片每个 gram 的出现总次数；「块外是否出现」用它和块内计数一次比对得出。 */
function totalGrams(cueGrams: Set<string>[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const grams of cueGrams) {
    for (const gram of grams) {
      totals.set(gram, (totals.get(gram) ?? 0) + 1);
    }
  }
  return totals;
}

function blockTerms(
  inside: Map<string, number>,
  totals: Map<string, number>,
  topic: Set<string>,
  start: number,
  end: number
): { novelty: WindowTerms | null; repeat: WindowTerms | null } {
  const insideTotal = [...inside.values()].reduce((sum, count) => sum + count, 0);
  // 全量计数只算一次；每个块的「块外」判定变成一次查表比对，复杂度从 O(块数×台词数) 降到 O(台词数)。
  const outsideAbsent = (term: string): boolean =>
    (totals.get(term) ?? 0) === (inside.get(term) ?? 0);
  const novelTerms = [...inside.keys()].filter(
    (term) => outsideAbsent(term) && !topic.has(term)
  );
  const repeated = [...inside.entries()]
    .filter(([term, count]) => count >= 2 && outsideAbsent(term) && !topic.has(term))
    .map(([term]) => term)
    .sort();
  // share 按「新词出现次数」算，而不是「去重后新词个数」：
  // 同一句新台词重复三遍，语义上仍是 100% 新内容，不能因为去重被摊薄成 1/3。
  const novelOccurrences = novelTerms.reduce((sum, term) => sum + (inside.get(term) ?? 0), 0);
  return {
    novelty:
      novelTerms.length > 0
        ? {
            start,
            end,
            terms: novelTerms.slice(0, 12),
            share: insideTotal > 0 ? novelOccurrences / insideTotal : 0
          }
        : null,
    repeat: repeated.length > 0 ? { start, end, terms: repeated.slice(0, 12) } : null
  };
}

function findNoveltyAndRepeat(
  cues: SubtitleCue[],
  title: string,
  description: string,
  duration: number,
  blockSeconds = 60
): { novelty: WindowTerms[]; repeat: WindowTerms[] } {
  if (cues.length === 0 || duration <= 0) return { novelty: [], repeat: [] };
  const topic = topicGrams(title, description);
  const cueGrams = cues.map((cue) => grams4(cue.text));
  // 全量计数只算一次；每个块的「块外」判定变成一次查表比对，不再重建块外集合。
  const totals = totalGrams(cueGrams);
  const novelty: WindowTerms[] = [];
  const repeat: WindowTerms[] = [];

  for (let start = 0; start < duration; start += blockSeconds) {
    const end = Math.min(duration, start + blockSeconds);
    const indexes = blockIndexes(cues, start, end);
    if (indexes.length < 3) continue;
    const inside = insideGrams(cues, cueGrams, indexes);
    const terms = blockTerms(inside, totals, topic, start, end);
    if (terms.novelty) novelty.push(terms.novelty);
    if (terms.repeat) repeat.push(terms.repeat);
  }
  return { novelty, repeat };
}

/**
 * 弹幕密度突增：按固定窗口统计条数，显著高于全片平均密度才算突增。
 * 对应「证据族 density」，弹幕模式下的三类证据要求缺它不可。
 */
function findDensitySpikes(
  danmaku: DanmakuItem[],
  duration: number,
  windowSeconds = 10
): DensityWindow[] {
  if (danmaku.length === 0 || !Number.isFinite(duration) || duration <= 0) return [];
  const win = Math.max(1, windowSeconds);
  const step = Math.max(1, win / 2);
  const counts = countDensityBuckets(danmaku, duration, step);
  const prefix = prefixSums(counts);
  const expected = (danmaku.length * win) / duration;
  const threshold = Math.max(5, expected * 3);
  const spikes = collectDensitySpikes({
    prefix,
    bucketCount: counts.length,
    duration,
    step,
    win,
    threshold
  });
  return mergeDensityWindows(spikes).slice(0, 20);
}

/** 按 step 秒分桶统计弹幕条数；越界与非有限时间直接丢弃。 */
function countDensityBuckets(
  danmaku: DanmakuItem[],
  duration: number,
  step: number
): number[] {
  const bucketCount = Math.max(1, Math.ceil(duration / step));
  const counts = new Array<number>(bucketCount).fill(0);
  for (const item of danmaku) {
    if (!Number.isFinite(item.time) || item.time < 0 || item.time > duration) continue;
    const bucket = Math.min(bucketCount - 1, Math.floor(item.time / step));
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function prefixSums(counts: number[]): number[] {
  const prefix = new Array<number>(counts.length + 1).fill(0);
  for (let index = 0; index < counts.length; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (counts[index] ?? 0);
  }
  return prefix;
}

interface SpikeInput {
  prefix: number[];
  bucketCount: number;
  duration: number;
  step: number;
  win: number;
  threshold: number;
}

function collectDensitySpikes(input: SpikeInput): DensityWindow[] {
  const spikes: DensityWindow[] = [];
  for (let bucket = 0; bucket < input.bucketCount; bucket += 1) {
    const start = bucket * input.step;
    const end = Math.min(input.duration, start + input.win);
    const endBucket = Math.min(input.bucketCount, Math.ceil(end / input.step));
    const count = (input.prefix[endBucket] ?? 0) - (input.prefix[bucket] ?? 0);
    if (count >= input.threshold) spikes.push({ start, end, count });
  }
  return spikes;
}

/** 相邻或重叠的窗口合并成一段，计数取最大值。 */
function mergeDensityWindows(spikes: DensityWindow[]): DensityWindow[] {
  const merged: DensityWindow[] = [];
  for (const spike of [...spikes].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && spike.start <= last.end) {
      last.end = Math.max(last.end, spike.end);
      last.count = Math.max(last.count, spike.count);
    } else {
      merged.push({ ...spike });
    }
  }
  return merged;
}

export function buildSignals(input: SignalInput): SignalSet {
  const { novelty, repeat } = findNoveltyAndRepeat(
    input.cues,
    input.title,
    input.description,
    input.duration
  );
  return {
    jumpTargets: extractJumpTargets(input.danmaku, input.duration),
    adWordHits: findPhraseHits(
      input.danmaku,
      AD_WORDS,
      (item) => item.text,
      (item) => item.time
    ),
    divergentTerms: findDivergentTerms(input.cues, input.danmaku),
    ctaHits: findPhraseHits(
      input.cues,
      CTA_PHRASES,
      (cue) => cue.text,
      (cue) => cue.start
    ),
    chapterHits: findChapterHits(input.chapters),
    novelty,
    repeat,
    densitySpikes: findDensitySpikes(input.danmaku, input.duration),
    boundaries: findBoundaries(input.danmaku)
  };
}
