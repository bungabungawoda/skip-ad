import type { DecisionAnswer, DecisionClient, DecisionQuestion } from "../../src/core/ports/decision/types";

const CLOCK = /(\d{2}):(\d{2}) 到 (\d{2}):(\d{2})/;

function toSeconds(minutes: string | undefined, seconds: string | undefined): number {
  return Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/** 从问题正文里读出时间区间：模型看到的就是这些文字。 */
export function parseQuestionRange(text: string): { start: number; end: number } | undefined {
  const match = text.match(CLOCK);
  if (!match) return undefined;
  return {
    start: toSeconds(match[1], match[2]),
    end: toSeconds(match[3], match[4])
  };
}

export interface FakeDecisionModel extends DecisionClient {
  calls: Array<Record<string, DecisionQuestion>>;
}

const BOUNDARY_CHOICES = new Set(["start", "middle", "end", "none"]);

function isBoundaryQuestion(question: DecisionQuestion): boolean {
  return (
    question.type === "choice" &&
    Object.keys(question.criteria).every((key) => BOUNDARY_CHOICES.has(key))
  );
}

/** 1 秒一格的四选一：这一格包含广告起点就是 start，包含终点就是 end，整格在广告里就是 middle。 */
function answerBoundary(
  range: { start: number; end: number },
  ads: Array<[number, number]>
): { choice: string; confidence: number } {
  for (const [adStart, adEnd] of ads) {
    if (adStart >= range.start && adStart < range.end) {
      return { choice: "start", confidence: 0.9 };
    }
    if (adEnd > range.start && adEnd <= range.end) {
      return { choice: "end", confidence: 0.9 };
    }
    if (range.start >= adStart && range.end <= adEnd) {
      return { choice: "middle", confidence: 0.9 };
    }
  }
  return { choice: "none", confidence: 0.95 };
}

/**
 * 假决策模型：按广告区间回答。
 * 是/否题看区间有没有真的碰到广告；选择题选包含真边界的那一格。
 * whole 用来模拟「复核说这段不是广告」。
 */
export function fakeDecisionModel(
  ads: Array<[number, number]>,
  options: { whole?: number; neighbors?: number } = {}
): FakeDecisionModel {
  const calls: Array<Record<string, DecisionQuestion>> = [];
  const touches = (range: { start: number; end: number }): boolean =>
    ads.some(([start, end]) => range.end > start + 0.5 && range.start < end - 0.5);

  return {
    calls,
    async decide(request) {
      calls.push(request.questions);
      const answers: Record<string, DecisionAnswer> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "noul") {
          const range = parseQuestionRange(question.instructions);
          const isNeighbor = key === "prev" || key === "next";
          const probability = isNeighbor && options.neighbors !== undefined
            ? options.neighbors
            : range && touches(range)
              ? (options.whole ?? 0.95)
              : 0.05;
          answers[key] = { type: "noul", noul: probability, confidence: probability };
          continue;
        }
        if (key === "kind") {
          answers[key] = {
            type: "choice",
            choice: "sponsor",
            probabilities: { sponsor: 1 },
            confidence: 1
          };
          continue;
        }
        if (isBoundaryQuestion(question)) {
          const range = parseQuestionRange(question.instructions);
          const answer = range
            ? answerBoundary(range, ads)
            : { choice: "none", confidence: 0.95 };
          answers[key] = {
            type: "choice",
            choice: answer.choice,
            probabilities: { [answer.choice]: answer.confidence },
            confidence: answer.confidence
          };
          continue;
        }
        // 起点/结尾选择题：在选项里找包含真边界的那一格。
        const choices = Object.entries(question.criteria);
        const bounds = choices
          .map(([, description]) => parseQuestionRange(description))
          .filter((range): range is { start: number; end: number } => range !== undefined);
        const low = Math.min(...bounds.map((range) => range.start));
        const high = Math.max(...bounds.map((range) => range.end));
        const truths = ads.map(([start, end]) => (key === "start" ? start : end));
        const truth = truths.find((value) => value >= low && value < high);
        const chosen =
          choices.find(([, description]) => {
            const range = parseQuestionRange(description);
            return range && truth !== undefined && truth >= range.start && truth < range.end;
          })?.[0] ?? choices[0]?.[0] ?? "b00";
        answers[key] = {
          type: "choice",
          choice: chosen,
          probabilities: { [chosen]: 0.4 },
          confidence: 0.4
        };
      }
      return { answers };
    }
  };
}
