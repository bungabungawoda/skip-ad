/**
 * 用决策模型判广告：粗扫 → 细扫 → 边界搜索 → 吸附 → 复核。
 *
 * 分工：模型只回答「这一格有没有广告」「起点落在哪一格」「这一句算不算」，
 * 时间轴、格子、秒数全部由这里算。模型没有机会编时间，因为它从不输出时间。
 */

import type { Segment, SegmentKind } from "../../plugin/types";
import type { AnalysisWarning } from "../types";
import type { DecisionClient, DecisionQuestion } from "../../ports/decision/types";
import { logInfo, logWarn } from "../../lib/log";
import { clamp } from "../../lib/time";
import { applyVerify, findNeighbors, type VerifyAnswers } from "./verify";
import { cuesInRange, formatTimeline, linesInRange } from "./timeline";
import {
  buildWindows,
  expandRange,
  groupWindowsByBlock,
  mergeHitWindows,
  type ScanWindow,
  type TimeRange
} from "./windows";
import {
  BOUNDARY_CRITERIA,
  KIND_CRITERIA,
  KIND_QUESTION,
  boundaryQuestion,
  buildInputPreamble,
  cueIsAdQuestion,
  fineQuestion,
  scanQuestion,
  verifyNeighborQuestion,
  verifyWholeQuestion
} from "./prompts";
import {
  type DecisionAnalysisInput,
  type DecisionAnalysisResult,
  type TimelineLine
} from "./types";
import { MIN_SEGMENT_SECONDS } from "../../lib/limits";

interface DecisionStage {
  kind: "scan" | "fine";
  done: number;
  total: number;
}

interface DecisionPipelineDeps {
  client: DecisionClient;
  signal?: AbortSignal;
  onStage?: (stage: DecisionStage) => void;
  /** 每确认一段回调一次，界面用它先画已找到的色块。 */
  onSegment?: (segment: Segment) => void;
}

/**
 * 流程的固定参数。每一项都按实测调过：5 分钟粗扫窗口里广告只占 17% 也能给 0.99，
 * 30 秒细扫能把广告段和非广告段分开，边界逐秒四选一。
 *
 * 没有做成可配置项：没有任何调用方需要改它们，留一个 options 形参只会让人
 * 以为这些值在某处被覆盖。
 */
const DECISION = {
  /** 粗扫窗口长度。 */
  scanWindowSeconds: 300,
  /** 粗扫步长，小于窗口长度形成重叠，防止广告正好跨在边界上。 */
  scanStrideSeconds: 270,
  /** 粗扫命中阈值：低于它的窗口不进候选。 */
  scanThreshold: 0.5,
  /** 合并命中窗口时允许跳过的窗口数；2 表示中间夹一个低分窗口仍算同一段。 */
  scanMaxIndexGap: 2,
  /** 一次请求承载的时间跨度上限；长视频按它切块，避免长输入稀释准确率。 */
  blockSeconds: 600,
  /** 候选段内的细扫窗口长度。 */
  fineWindowSeconds: 30,
  fineStrideSeconds: 15,
  /** 细扫范围在候选段两侧各扩多少秒，给跨界广告留余量。 */
  fineExpandSeconds: 60,
  /** 边界窗口在细扫窗口两侧各留多少秒，避免真边界落在窗口边缘。 */
  searchPaddingSeconds: 5,
  /** 片段最短长度，沿用策略层的规则。 */
  minSegmentSeconds: MIN_SEGMENT_SECONDS,
  /** 复核：整段是不是广告，低于它就不认这一轮。 */
  verifyWholeThreshold: 0.9,
  /** 复核：相邻那句是不是也属于广告，高于它就向那一侧扩一句。 */
  verifyNeighborThreshold: 0.5,
  /** 复核最多跑几轮（每轮可以向外扩一句）。 */
  maxVerifyRounds: 2,
  /** 边界四选一的单位长度；1 表示逐秒判断。 */
  boundaryUnitSeconds: 1,
  /** 边界四选一的最低置信度：低于它的 start/end 不认。 */
  boundaryThreshold: 0.8,
  /** 边界四选一时，问题窗口外再带多少秒上下文，帮助模型分清起始、中间与结束。 */
  boundaryContextSeconds: 60,
  /** 一次边界请求最多问多少秒；超过时把窗口裁到中心附近。 */
  boundaryMaxSeconds: 45
} as const;

const WINDOW_KEY_PREFIX = "w";

/**
 * 逐句定位一次最多问几句。长商单口播常跨 30–60 句，只问中心 12 句会把
 * 片段截成核心一小段；80 句能覆盖大多数几分钟内的候选段，又不至于让单次
 * 请求膨胀到不可控。
 */
const MAX_UNIT_QUESTIONS = 80;

/** 没有台词时，逐段问的单位长度。5 秒和弹幕桶对齐，边界精度也就是 5 秒。 */
const DANMAKU_UNIT_SECONDS = 5;

function windowKey(index: number): string {
  return `${WINDOW_KEY_PREFIX}${String(index).padStart(3, "0")}`;
}

function textInput(text: string) {
  return [{ type: "text" as const, text }];
}

function requireAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("分析已取消");
}

/** 粗扫一块：一块一次请求，块内每个窗口一个问题。 */
async function scanBlock(
  client: DecisionClient,
  block: { range: TimeRange; windows: ScanWindow[] },
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<Map<number, number>> {
  const lines = linesInRange(input.lines, block.range);
  const text = `${buildInputPreamble(input.rubric, input.notes ?? [])}\n\n${formatTimeline(lines)}`;
  const questions: Record<string, DecisionQuestion> = {};
  for (const window of block.windows) {
    questions[windowKey(window.index)] = {
      type: "noul",
      instructions: scanQuestion(window)
    };
  }
  const result = await client.decide({
    input: textInput(text),
    questions,
    videoDurationMs: input.duration * 1000,
    ...(signal ? { signal } : {})
  });
  const probabilities = new Map<number, number>();
  for (const window of block.windows) {
    const answer = result.answers[windowKey(window.index)];
    probabilities.set(window.index, answer?.type === "noul" ? answer.noul : 0);
  }
  return probabilities;
}

interface FineScan {
  windows: ScanWindow[];
  probabilities: number[];
}

/** 细扫：候选段内 30 秒一格，用来把边界收窄到一个窗口。 */
async function fineScan(
  client: DecisionClient,
  range: TimeRange,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<FineScan> {
  const windows = buildWindows(range, {
    windowSeconds: DECISION.fineWindowSeconds,
    strideSeconds: DECISION.fineStrideSeconds
  });
  const lines = linesInRange(input.lines, range);
  const text = `${buildInputPreamble(input.rubric, input.notes ?? [])}\n\n${formatTimeline(lines)}`;
  const questions: Record<string, DecisionQuestion> = {};
  for (const window of windows) {
    questions[windowKey(window.index)] = { type: "noul", instructions: fineQuestion(window) };
  }
  const result = await client.decide({
    input: textInput(text),
    questions,
    videoDurationMs: input.duration * 1000,
    ...(signal ? { signal } : {})
  });
  const probabilities = windows.map((window) => {
    const answer = result.answers[windowKey(window.index)];
    return answer?.type === "noul" ? answer.noul : 0;
  });
  return { windows, probabilities };
}

interface BoundaryChoice {
  start: number;
  end: number;
  choice: string;
  confidence: number;
}

/** 把一段范围按固定单位切开，单位边缘就是问题里的起止时间。 */
function buildUnitRanges(
  range: TimeRange,
  unitSeconds: number,
  duration: number
): TimeRange[] {
  const unit = Math.max(1, unitSeconds);
  const from = clamp(Math.floor(range.start), 0, duration);
  const to = clamp(Math.ceil(range.end), 0, duration);
  const units: TimeRange[] = [];
  for (let start = from; start < to; start += unit) {
    units.push({ start, end: Math.min(to, start + unit) });
  }
  return units;
}

/** 一次边界请求最多问 boundaryMaxSeconds 秒；超长窗口裁到中心附近。 */
function cropBoundaryRange(
  range: TimeRange,
  maxSeconds: number,
  duration: number
): TimeRange {
  const length = range.end - range.start;
  if (length <= maxSeconds) return range;
  const center = (range.start + range.end) / 2;
  let start = clamp(center - maxSeconds / 2, 0, duration);
  let end = clamp(start + maxSeconds, 0, duration);
  if (end - start < maxSeconds) start = clamp(end - maxSeconds, 0, duration);
  end = clamp(start + maxSeconds, 0, duration);
  return { start, end };
}

/**
 * 边界四选一：把一段范围逐秒切开，问每一秒是起始、中间、结束还是不属于广告。
 * 问题只覆盖目标窗口，共享输入额外带上前后文，模型能分清边界而不是只看孤立一秒。
 */
async function askBoundaryChoices(
  client: DecisionClient,
  range: TimeRange,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<BoundaryChoice[]> {
  const bounded = cropBoundaryRange(range, DECISION.boundaryMaxSeconds, input.duration);
  const units = buildUnitRanges(bounded, DECISION.boundaryUnitSeconds, input.duration);
  if (units.length === 0) return [];
  const questions: Record<string, DecisionQuestion> = {};
  units.forEach((unit, index) => {
    questions[`s${index}`] = {
      type: "choice",
      instructions: boundaryQuestion(unit),
      criteria: BOUNDARY_CRITERIA
    };
  });
  const context = expandRange(bounded, DECISION.boundaryContextSeconds, input.duration);
  const text = `${buildInputPreamble(input.rubric, input.notes ?? [])}\n\n${formatTimeline(
    linesInRange(input.lines, context)
  )}`;
  const result = await client.decide({
    input: textInput(text),
    questions,
    videoDurationMs: input.duration * 1000,
    ...(signal ? { signal } : {})
  });
  return units.map((unit, index) => {
    const answer = result.answers[`s${index}`];
    if (answer?.type !== "choice" || !(answer.choice in BOUNDARY_CRITERIA)) {
      return { ...unit, choice: "none", confidence: 0 };
    }
    return { ...unit, choice: answer.choice, confidence: answer.confidence };
  });
}

function firstBoundary(
  choices: BoundaryChoice[],
  kind: "start" | "end",
  threshold: number
): BoundaryChoice | undefined {
  const matches = choices.filter(
    (choice) => choice.choice === kind && choice.confidence >= threshold
  );
  return kind === "start" ? matches[0] : matches[matches.length - 1];
}

/**
 * 用逐秒四选一定位边界。起点窗口和终点窗口分开问；短广告两个窗口重合时只问一次。
 * 起点取第一个高置信度的 start，终点取最后一个高置信度的 end。
 */
async function locateBySeconds(
  client: DecisionClient,
  startBracket: TimeRange,
  endBracket: TimeRange,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<{ range: TimeRange; confidence: number } | undefined> {
  const union: TimeRange = {
    start: Math.min(startBracket.start, endBracket.start),
    end: Math.max(startBracket.end, endBracket.end)
  };
  const oneAsk = union.end - union.start <= DECISION.boundaryMaxSeconds;
  const asks: BoundaryChoice[][] = [];
  if (oneAsk) {
    asks.push(await askBoundaryChoices(client, union, input, signal));
  } else {
    asks.push(await askBoundaryChoices(client, startBracket, input, signal));
    asks.push(await askBoundaryChoices(client, endBracket, input, signal));
  }
  const start =
    firstBoundary(asks[0] ?? [], "start", DECISION.boundaryThreshold) ??
    firstBoundary(asks[1] ?? [], "start", DECISION.boundaryThreshold);
  const end =
    firstBoundary(asks[asks.length - 1] ?? [], "end", DECISION.boundaryThreshold) ??
    firstBoundary(asks[0] ?? [], "end", DECISION.boundaryThreshold);
  if (!start || !end || start.start >= end.end) return undefined;
  return {
    range: { start: start.start, end: end.end },
    confidence: Math.min(start.confidence, end.confidence)
  };
}

interface LocatedSegment {
  range: TimeRange;
  confidence: number;
}

/**
 * 定位：把边界窗口切成一个个「单位」，逐个问「这一段算不算广告」。
 * 有台词时单位是句子，没有台词时是 5 秒的弹幕桶；单位边缘就是片段边缘。
 */
async function locate(
  client: DecisionClient,
  run: TimeRange,
  fine: FineScan,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<LocatedSegment> {
  const duration = input.duration;
  const first = fine.windows.find((window) => window.start >= run.start - 0.01) ?? fine.windows[0];
  const last =
    [...fine.windows].reverse().find((window) => window.end <= run.end + 0.01) ??
    fine.windows[fine.windows.length - 1];
  if (!first || !last) {
    return { range: run, confidence: 0 };
  }

  const startBracket: TimeRange = {
    start: clamp(first.start - DECISION.searchPaddingSeconds, 0, duration),
    end: clamp(first.end + DECISION.searchPaddingSeconds, 0, duration)
  };
  const endBracket: TimeRange = {
    start: clamp(last.start - DECISION.searchPaddingSeconds, 0, duration),
    end: clamp(last.end + DECISION.searchPaddingSeconds, 0, duration)
  };
  const atVideoStart = first.start <= 0;
  const atVideoEnd = last.end >= duration - 0.01;

  // 先用逐秒四选一定边界；找不到 start/end 时退回逐句定位。
  const boundary = await locateBySeconds(client, startBracket, endBracket, input, signal);
  if (boundary) {
    return {
      range: {
        start: atVideoStart ? 0 : boundary.range.start,
        end: atVideoEnd ? duration : boundary.range.end
      },
      confidence: boundary.confidence
    };
  }

  const cues = cuesInRange(input.lines, {
    start: startBracket.start,
    end: endBracket.end
  });

  // 有台词就逐句问「这一句算不算广告」，边界天然落在句子两端。
  const units =
    cues.length > 0
      ? cues
      : buildWindows(
          { start: startBracket.start, end: endBracket.end },
          { windowSeconds: DANMAKU_UNIT_SECONDS, strideSeconds: DANMAKU_UNIT_SECONDS }
        ).map((window) => ({
          start: window.start,
          end: window.end,
          text: "",
          kind: "note" as const
        }));

  const located = await locateByUnits(client, units, run, input, signal, cues.length > 0);
  if (!located) {
    return { range: { start: run.start, end: run.end }, confidence: 0 };
  }
  return {
    range: {
      start: atVideoStart ? 0 : located.range.start,
      end: atVideoEnd ? duration : located.range.end
    },
    confidence: located.confidence
  };
}

/**
 * 逐个单位问「这一段算不算广告」，取包含中心的那一段连续区间。
 *
 * 有台词时单位是句子，边界天然落在句子两端；没有台词时单位是 5 秒的弹幕桶，
 * 边界精度就是一个桶。两种情况用同一套逻辑：问语义，不问「第几格」。
 */
/** 台词可能上百句：只问离中心最近的若干句，提问顺序仍按时间。 */
function pickUnitsAroundCenter(units: TimelineLine[], center: number): TimelineLine[] {
  const ordered = [...units].sort((a, b) => a.start - b.start);
  if (ordered.length <= MAX_UNIT_QUESTIONS) return ordered;
  return [...ordered]
    .sort(
      (a, b) =>
        Math.abs((a.start + a.end) / 2 - center) -
        Math.abs((b.start + b.end) / 2 - center)
    )
    .slice(0, MAX_UNIT_QUESTIONS)
    .sort((a, b) => a.start - b.start);
}

function buildUnitQuestions(
  units: TimelineLine[],
  isCue: boolean
): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  units.forEach((unit, index) => {
    questions[`c${index}`] = {
      type: "noul",
      instructions: isCue ? cueIsAdQuestion(unit) : fineQuestion(unit)
    };
  });
  return questions;
}

/** 只保留包含种子点的那一段连续广告，避免窗口边缘的误判把片段拉长。 */
function contiguousAdRun(isAd: boolean[], seed: number): { low: number; high: number } {
  let low = seed;
  let high = seed;
  while (low - 1 >= 0 && isAd[low - 1]) low -= 1;
  while (high + 1 < isAd.length && isAd[high + 1]) high += 1;
  return { low, high };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

async function locateByUnits(
  client: DecisionClient,
  units: TimelineLine[],
  run: TimeRange,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined,
  isCue: boolean
): Promise<{ range: TimeRange; confidence: number } | undefined> {
  const center = (run.start + run.end) / 2;
  const selected = pickUnitsAroundCenter(units, center);
  const questions = buildUnitQuestions(selected, isCue);
  const text = `${buildInputPreamble(input.rubric, input.notes ?? [])}\n\n${formatTimeline(
    linesInRange(input.lines, { start: selected[0]?.start ?? run.start, end: selected[selected.length - 1]?.end ?? run.end })
  )}`;
  const result = await client.decide({
    input: textInput(text),
    questions,
    videoDurationMs: input.duration * 1000,
    ...(signal ? { signal } : {})
  });

  const probabilities = selected.map((_, index) => {
    const answer = result.answers[`c${index}`];
    return answer?.type === "noul" ? answer.noul : 0;
  });
  const isAd = probabilities.map((probability) => probability >= DECISION.scanThreshold);
  const seed = selected.reduce(
    (best, unit, index) => {
      if (!isAd[index]) return best;
      const distance = Math.abs((unit.start + unit.end) / 2 - center);
      return distance < best.distance ? { index, distance } : best;
    },
    { index: -1, distance: Infinity }
  ).index;
  if (seed < 0) return undefined;

  // 只取包含中心的那一段连续广告，避免窗口边缘的误判把片段拉长。
  const { low, high } = contiguousAdRun(isAd, seed);
  const startCue = selected[low];
  const endCue = selected[high];
  if (!startCue || !endCue) return undefined;
  // 置信度取片段内几句台词的平均概率：比细扫窗口的均值更能反映这一段本身。
  const confidence = average(probabilities.slice(low, high + 1));
  return { range: { start: startCue.start, end: endCue.end }, confidence };
}

interface VerifiedSegment {
  range: TimeRange;
  confidence: number;
  kind: SegmentKind;
  whole: number;
  rounds: number;
}

/** 复核一轮：整段、前一句、后一句、类型，四个问题一次问完。 */
async function verifyOnce(
  client: DecisionClient,
  range: TimeRange,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<VerifyAnswers> {
  const neighbors = findNeighbors(input.lines, range);
  const window: TimeRange = {
    start: Math.max(0, range.start - 60),
    end: Math.min(input.duration, range.end + 60)
  };
  const text = `${buildInputPreamble(input.rubric, input.notes ?? [])}\n\n${formatTimeline(
    linesInRange(input.lines, window)
  )}`;
  const questions: Record<string, DecisionQuestion> = {
    whole: { type: "noul", instructions: verifyWholeQuestion(range) },
    kind: { type: "choice", instructions: KIND_QUESTION, criteria: KIND_CRITERIA }
  };
  if (neighbors.prev) {
    questions.prev = {
      type: "noul",
      instructions: verifyNeighborQuestion(neighbors.prev, "prev")
    };
  }
  if (neighbors.next) {
    questions.next = {
      type: "noul",
      instructions: verifyNeighborQuestion(neighbors.next, "next")
    };
  }
  const result = await client.decide({
    input: textInput(text),
    questions,
    videoDurationMs: input.duration * 1000,
    ...(signal ? { signal } : {})
  });
  const whole = result.answers.whole;
  const kind = result.answers.kind;
  const prev = result.answers.prev;
  const next = result.answers.next;
  return {
    whole: whole?.type === "noul" ? whole.noul : 0,
    ...(prev?.type === "noul" ? { prev: prev.noul } : {}),
    ...(next?.type === "noul" ? { next: next.noul } : {}),
    ...(kind?.type === "choice" && kind.choice in KIND_CRITERIA
      ? { kind: kind.choice as SegmentKind }
      : {})
  };
}

/** 复核最多跑 maxVerifyRounds 轮：每轮可以向外扩一句，扩完再看新邻居。 */
async function verifySegment(
  client: DecisionClient,
  located: LocatedSegment,
  input: DecisionAnalysisInput,
  signal: AbortSignal | undefined
): Promise<VerifiedSegment | undefined> {
  let range = located.range;
  let confidence = located.confidence;
  let kind: SegmentKind = "unknown";
  let whole = 0;
  let rounds = 0;
  /** 最近一轮整段复核实际覆盖且通过的范围：扩句后的复核失败就回退到这里。 */
  let trusted: VerifiedSegment | undefined;
  for (let round = 0; round < DECISION.maxVerifyRounds; round += 1) {
    const answers = await verifyOnce(client, range, input, signal);
    whole = answers.whole;
    kind = answers.kind ?? kind;
    const outcome = applyVerify({
      segment: range,
      neighbors: findNeighbors(input.lines, range),
      answers,
      baseConfidence: confidence,
      wholeThreshold: DECISION.verifyWholeThreshold,
      neighborThreshold: DECISION.verifyNeighborThreshold
    });
    if (!outcome) {
      // 扩句被新证据否定时，上一轮整段复核仍然有效：回退到那一轮的范围，
      // 不把整段丢掉。首轮就不过说明定位本身错了，维持丢弃语义。
      return trusted;
    }
    // 只有整段复核真正通过（whole >= 0.5）的窗口才值得回退；
    // 整段低分、靠邻句高分平移过来的窗口还没被确认，不能当成保底结果。
    if (whole >= 0.5) {
      trusted = {
        range,
        confidence: outcome.confidence,
        kind,
        whole,
        rounds: round + 1
      };
    }
    range = outcome.range;
    confidence = outcome.confidence;
    rounds = round + 1;
    if (!outcome.extended) return trusted;
  }
  // 最后一轮又扩了一句但没有剩余轮次复核：返回上一轮已经整段验证过的范围。
  return trusted ?? { range, confidence, kind, whole, rounds };
}

function buildSegment(
  verified: VerifiedSegment,
  lines: TimelineLine[]
): Segment {
  const quotes = linesInRange(lines, verified.range)
    .filter((line) => (line.kind ?? "cue") === "cue")
    .slice(0, 3)
    .map((line) => line.text);
  return {
    start: verified.range.start,
    end: verified.range.end,
    kind: verified.kind,
    confidence: verified.confidence,
    evidence: quotes,
    reason: "字幕和弹幕里出现付费推广内容，这段判定为广告",
    status: "closed"
  };
}

/** 相邻片段合并：两个候选段各自扩过之后可能重叠，重叠就并成一次跳。 */
export function mergeOverlappingSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.start < last.end) {
      last.end = Math.max(last.end, segment.end);
      // 类型先按置信度取舍，再抬整体置信度：顺序反过来，比较恒假，高置信度的类型永远进不来。
      if (segment.confidence > last.confidence) last.kind = segment.kind;
      last.confidence = Math.max(last.confidence, segment.confidence);
      last.evidence = [...last.evidence, ...segment.evidence].slice(0, 6);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export async function analyzeWithDecisions(
  input: DecisionAnalysisInput,
  deps: DecisionPipelineDeps
): Promise<DecisionAnalysisResult> {
  const warnings: AnalysisWarning[] = [];
  const client = deps.client;
  const lines = input.lines.filter((line) => line.end > line.start && line.text.trim().length > 0);

  if (!(input.duration > 0)) {
    return {
      segments: [],
      warnings: [{ code: "partial", message: "无法确定视频时长，未做时间轴判定" }]
    };
  }
  if (lines.length === 0) {
    return {
      segments: [],
      warnings: [{ code: "no_context", message: "没有可用的字幕或弹幕，未做分析" }]
    };
  }

  const windows = buildWindows(
    { start: 0, end: input.duration },
    { windowSeconds: DECISION.scanWindowSeconds, strideSeconds: DECISION.scanStrideSeconds }
  );
  const blocks = groupWindowsByBlock(windows, DECISION.blockSeconds);
  const probabilities = new Array<number>(windows.length).fill(0);
  for (const [index, block] of blocks.entries()) {
    requireAborted(deps.signal);
    deps.onStage?.({ kind: "scan", done: index, total: blocks.length });
    const blockProbabilities = await scanBlock(client, block, input, deps.signal);
    for (const [windowIndex, probability] of blockProbabilities) {
      probabilities[windowIndex] = probability;
    }
  }
  deps.onStage?.({ kind: "scan", done: blocks.length, total: blocks.length });

  const candidates = mergeHitWindows(windows, probabilities, {
    threshold: DECISION.scanThreshold,
    maxIndexGap: DECISION.scanMaxIndexGap
  });
  logInfo("决策粗扫完成", {
    windows: windows.length,
    blocks: blocks.length,
    candidates: candidates.length,
    duration: input.duration
  });
  const segments: Segment[] = [];
  for (const [index, candidate] of candidates.entries()) {
    requireAborted(deps.signal);
    deps.onStage?.({ kind: "fine", done: index, total: candidates.length });
    const range = expandRange(candidate, DECISION.fineExpandSeconds, input.duration);
    try {
      const fine = await fineScan(client, range, input, deps.signal);
      const runs = mergeHitWindows(fine.windows, fine.probabilities, {
        threshold: DECISION.scanThreshold,
        maxIndexGap: DECISION.scanMaxIndexGap
      });
      for (const run of runs) {
        requireAborted(deps.signal);
        const located = await locate(client, run, fine, input, deps.signal);
        const verified = await verifySegment(client, located, input, deps.signal);
        if (!verified) {
          logInfo("决策复核否决候选段", { start: run.start, end: run.end });
          continue;
        }
        if (verified.range.end - verified.range.start < DECISION.minSegmentSeconds) {
          logInfo("决策候选段短于最短时长，丢弃", {
            start: verified.range.start,
            end: verified.range.end,
            minSeconds: DECISION.minSegmentSeconds
          });
          continue;
        }
        const segment = buildSegment(verified, input.lines);
        segments.push(segment);
        deps.onSegment?.(segment);
      }
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      logWarn("决策候选段定位失败", {
        start: candidate.start,
        end: candidate.end,
        error: error instanceof Error ? error.message : String(error)
      });
      warnings.push({
        code: "llm_failed",
        message: `候选段 ${candidate.start.toFixed(0)}–${candidate.end.toFixed(0)} 秒定位失败：${
          error instanceof Error ? error.message : String(error)
        }`
      });
    }
  }

  return { segments: mergeOverlappingSegments(segments), warnings };
}
