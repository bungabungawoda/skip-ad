import { describe, expect, it } from "vitest";
import type { DecisionClient, DecisionQuestion } from "../src/core/ports/decision/types";
import { analyzeWithDecisions } from "../src/core/analysis/decision/pipeline";
import { fakeDecisionModel } from "./helpers/decision";

/** 首轮复核通过后，第二轮复核否掉扩句，应保留首轮验证过的范围。 */
describe("复核扩句被否定时回退", () => {
  it("第二轮复核不过时保留首轮验证过的范围", async () => {
    const inner = fakeDecisionModel([[100, 150]], { neighbors: 0.9 });
    let verifyCalls = 0;
    const client: DecisionClient = {
      async decide(request) {
        const keys = Object.keys(request.questions);
        if (keys.includes("whole")) {
          verifyCalls += 1;
          const whole = verifyCalls === 1 ? 0.9 : 0.3;
          const answers: Record<string, import("../src/core/ports/decision/types").DecisionAnswer> = {};
          for (const [key, question] of Object.entries(request.questions) as Array<[string, DecisionQuestion]>) {
            if (question.type === "noul") {
              answers[key] = {
                type: "noul",
                noul: key === "whole" ? whole : question.instructions.includes("prev") ? 0.9 : 0.9,
                confidence: 1
              };
            } else if (key === "kind") {
              answers[key] = { type: "choice", choice: "sponsor", probabilities: { sponsor: 1 }, confidence: 1 };
            }
          }
          return { answers };
        }
        return inner.decide(request);
      }
    };
    const lines = [];
    for (let start = 0; start + 5 <= 300; start += 5) {
      lines.push({ start, end: start + 5, text: `第 ${start} 秒的台词`, kind: "cue" as const });
    }
    const result = await analyzeWithDecisions(
      { duration: 300, lines, rubric: "商单口播算付费广告。", notes: [] },
      { client }
    );
    expect(verifyCalls).toBe(2);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 150, kind: "sponsor" });
  });
});
