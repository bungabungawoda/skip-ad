import type { SignalSet } from "./signals";
import { clamp } from "../../../core/lib/time";

/**
 * 候选窗口的组成项。模型不需要 score，只需要知道这个窗口里有什么：
 * 空降票按票数累计，其余按命中条数计。
 */
interface CandidateParts {
  jump: number;
  adWord: number;
  chapter: number;
  divergent: number;
  transcript: number;
}

export interface CandidateWindow {
  start: number;
  end: number;
  score: number;
  arms: string[];
  parts: CandidateParts;
}

type BareWindow = Omit<CandidateWindow, "parts">;

interface BinState {
  score: number;
  arms: Set<string>;
}

const BIN_SECONDS = 15;

function binOf(time: number, duration: number): number {
  const count = Math.max(1, Math.ceil(duration / BIN_SECONDS));
  return clamp(Math.floor(time / BIN_SECONDS), 0, count - 1);
}

function binStart(index: number): number {
  return index * BIN_SECONDS;
}

interface BinAccumulator {
  bins: Map<number, BinState>;
  duration: number;
}

function addBin(acc: BinAccumulator, index: number, score: number, arm: string): void {
  const existing = acc.bins.get(index) ?? { score: 0, arms: new Set<string>() };
  existing.score += score;
  existing.arms.add(arm);
  acc.bins.set(index, existing);
}

function addJumpBins(acc: BinAccumulator, signals: SignalSet): void {
  for (const target of signals.jumpTargets) {
    if (target.votes < 2) continue;
    addBin(acc, binOf(target.time, acc.duration), 0.3 * Math.min(1, target.votes / 4), "jump_coordinate");
  }
}

function addCountedBins(
  acc: BinAccumulator,
  hits: Array<{ time: number }>,
  threshold: number,
  weight: number,
  arm: string
): void {
  const counts = new Map<number, number>();
  for (const hit of hits) {
    const index = binOf(hit.time, acc.duration);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  for (const [index, count] of counts) {
    if (count >= threshold) addBin(acc, index, weight * Math.min(1, count / 4), arm);
  }
}

function addChapterBins(acc: BinAccumulator, signals: SignalSet): void {
  for (const chapter of signals.chapterHits) {
    const first = binOf(chapter.start, acc.duration);
    const last = binOf(Math.max(chapter.start, chapter.end - 0.1), acc.duration);
    for (let index = first; index <= last; index += 1) addBin(acc, index, 0.1, "chapter");
  }
}

function addTermBins(acc: BinAccumulator, signals: SignalSet): void {
  for (const term of signals.divergentTerms) {
    addBin(acc, binOf((term.first + term.last) / 2, acc.duration), 0.15, "divergent_term");
  }
}

function addStructuralBins(acc: BinAccumulator, signals: SignalSet): void {
  for (const novelty of signals.novelty) {
    if ((novelty.share ?? 0) < 0.5) continue;
    addBin(acc, binOf(novelty.start, acc.duration), 0.1, "transcript");
  }
  for (const repeat of signals.repeat) {
    addBin(acc, binOf(repeat.start, acc.duration), 0.05, "transcript");
  }
}

function toWindow(
  state: { first: number; last: number; score: number; arms: Set<string> },
  duration: number
): BareWindow {
  const start = Math.max(0, binStart(state.first) - 10);
  const end = Math.min(duration, binStart(state.last + 1) + 10);
  return {
    start,
    end,
    score: Number(state.score.toFixed(3)),
    arms: [...state.arms].sort()
  };
}

function mergeBins(acc: BinAccumulator): BareWindow[] {
  const ordered = [...acc.bins.entries()].sort((a, b) => a[0] - b[0]);
  const windows: BareWindow[] = [];
  let current: { first: number; last: number; score: number; arms: Set<string> } | null = null;
  for (const [index, state] of ordered) {
    if (current && index - current.last <= 1) {
      current.last = index;
      current.score += state.score;
      state.arms.forEach((arm) => current?.arms.add(arm));
      continue;
    }
    if (current) windows.push(toWindow(current, acc.duration));
    current = { first: index, last: index, score: state.score, arms: new Set(state.arms) };
  }
  if (current) windows.push(toWindow(current, acc.duration));
  return windows;
}

function inWindow(time: number, window: BareWindow): boolean {
  return time >= window.start && time <= window.end;
}

/** 统计窗口里的证据组成；只用于给模型看，不参与分数。 */
function countParts(window: BareWindow, signals: SignalSet): CandidateParts {
  const jump = signals.jumpTargets
    .filter((target) => inWindow(target.time, window))
    .reduce((sum, target) => sum + target.votes, 0);
  const adWord = signals.adWordHits.filter((hit) => inWindow(hit.time, window)).length;
  const chapter = signals.chapterHits.filter(
    (hit) => hit.end > window.start && hit.start < window.end
  ).length;
  const divergent = signals.divergentTerms.filter((term) =>
    inWindow((term.first + term.last) / 2, window)
  ).length;
  const transcript =
    signals.ctaHits.filter((hit) => inWindow(hit.time, window)).length +
    signals.novelty.filter((block) => inWindow(block.start, window)).length +
    signals.repeat.filter((block) => inWindow(block.start, window)).length;
  return { jump, adWord, chapter, divergent, transcript };
}

export function deriveCandidates(
  signals: SignalSet,
  duration: number,
  maxCandidates = 8
): CandidateWindow[] {
  if (duration <= 0) return [];
  const acc: BinAccumulator = { bins: new Map(), duration };
  addJumpBins(acc, signals);
  addCountedBins(acc, signals.adWordHits, 2, 0.2, "ad_word");
  addCountedBins(acc, signals.ctaHits, 2, 0.15, "transcript");
  addChapterBins(acc, signals);
  addTermBins(acc, signals);
  addStructuralBins(acc, signals);
  return mergeBins(acc)
    .map((window) => ({ ...window, parts: countParts(window, signals) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
