import { describe, expect, it } from "vitest";
import type {
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion
} from "../../../ports/decision/types";
import { analyzeWithDecisions, mergeOverlappingSegments } from "../pipeline";
import { LlmError } from "../../../ports/llm/errors";
import type { TimelineLine } from "../types";
import { fakeDecisionModel, parseQuestionRange } from "../../../../../tests/helpers/decision";

/** 一分钟一句台词，覆盖 0 到 duration；把台词排在整分钟上，边界容易核对。 */
function makeLines(duration: number): TimelineLine[] {
  const lines: TimelineLine[] = [];
  for (let start = 0; start + 5 <= duration; start += 5) {
    lines.push({ start, end: start + 5, text: `第 ${start} 秒的台词`, kind: "cue" });
  }
  return lines;
}

const input = (duration: number, lines = makeLines(duration)) => ({
  duration,
  lines,
  rubric: "商单口播算付费广告；求三连不算。",
  notes: ["弹幕是裁剪后的样本。"]
});

function isBoundaryChoice(question: DecisionQuestion): boolean {
  return (
    question.type === "choice" &&
    Object.keys(question.criteria).every((key) =>
      ["start", "middle", "end", "none"].includes(key)
    )
  );
}

/** 边界四选一全选 none，逼迫流程退回逐句定位。 */
function refusingBoundaryModel(): DecisionClient {
  return {
    async decide(request) {
      const answers: Record<string, DecisionAnswer> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (isBoundaryChoice(question)) {
          const choice = "none";
          answers[key] = {
            type: "choice",
            choice,
            probabilities: { [choice]: 0.95 },
            confidence: 0.95
          };
        } else if (key === "kind") {
          answers[key] = {
            type: "choice",
            choice: "sponsor",
            probabilities: { sponsor: 1 },
            confidence: 1
          };
        } else {
          const range = parseQuestionRange(question.instructions);
          const hit = range && range.end > 100 && range.start < 150;
          const probability = hit ? 0.95 : 0.05;
          answers[key] = {
            type: "noul",
            noul: probability,
            confidence: probability
          };
        }
      }
      return {
        answers
      };
    }
  };
}

describe("决策流程", () => {
  it("找到一段广告，起止对齐台词边界", async () => {
    const client = fakeDecisionModel([[100, 150]]);
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 150, kind: "sponsor", status: "closed" });
    expect(result.segments[0]?.confidence).toBeGreaterThan(0.5);
  });

  it("长广告逐句定位覆盖整段，不被中心截断", async () => {
    const client = fakeDecisionModel([[100, 220]]);
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 220 });
  });

  it("边界四选一找不到时退回逐句定位，结果仍对齐台词边界", async () => {
    const result = await analyzeWithDecisions(input(300), {
      client: refusingBoundaryModel()
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 150 });
  });

  it("边界阶段按 1 秒四选一问起始、中间、结束与不属于广告", async () => {
    const client = fakeDecisionModel([[100, 150]]);
    const result = await analyzeWithDecisions(input(300), { client });
    const boundary = client.calls.find((questions) =>
      Object.values(questions).some(
        (question) =>
          question.type === "choice" &&
          "start" in question.criteria &&
          "end" in question.criteria
      )
    );
    expect(boundary).toBeDefined();
    const questions = Object.values(boundary ?? {});
    expect(questions.length).toBeGreaterThanOrEqual(30);
    expect(
      questions.every((question) => question.type === "choice")
    ).toBe(true);
    const ranges = questions.map((question) =>
      parseQuestionRange(question.instructions)
    );
    expect(ranges.every((range) => range && range.end - range.start === 1)).toBe(true);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 150 });
    expect(result.segments[0]?.reason).toBeTruthy();
    expect(result.segments[0]?.reason).not.toMatch(/逐秒|四选一|整段复核|0\.\d+/);
  });

  it("没有广告时只发一次粗扫请求", async () => {
    const client = fakeDecisionModel([]);
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it("两段广告各走一遍定位，互不影响", async () => {
    const client = fakeDecisionModel([
      [100, 150],
      [210, 240]
    ]);
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [100, 150],
      [210, 240]
    ]);
  });

  it("整段复核不通过时丢弃这段", async () => {
    const client = fakeDecisionModel([[100, 150]], { whole: 0.3 });
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments).toEqual([]);
  });

  it("最后一轮扩句后没有剩余轮次时，不返回未复核的新范围", async () => {
    const client = fakeDecisionModel([[90, 150]], { neighbors: 0.9 });
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 85, end: 155 });
    expect(result.segments[0]?.reason).toBeTruthy();
    expect(result.segments[0]?.reason).not.toMatch(/逐秒|四选一|整段复核|0\.\d+/);
  });

  it("长视频按块发粗扫，每块一次请求", async () => {
    const client = fakeDecisionModel([[700, 760]]);
    const result = await analyzeWithDecisions(input(1800), { client });
    // 1800 秒按 300 秒窗口、270 秒步长铺出 7 个窗口（0、270、…、1620），600 秒一块。
    const scanCalls = client.calls.filter((questions) =>
      Object.values(questions).every((question) => question.type === "noul")
    );
    expect(scanCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.segments).toHaveLength(1);
  });

  it("粗扫请求失败时整次分析失败，不伪装成没有广告", async () => {
    const failing: DecisionClient = {
      decide: async () => {
        throw new Error("network down");
      }
    };
    await expect(analyzeWithDecisions(input(300), { client: failing })).rejects.toThrow(
      "network down"
    );
  });

  it("内部重试后仍失败时把失败留给上层", async () => {
    const model = fakeDecisionModel([[100, 150]]);
    const client: DecisionClient = {
      async decide(request) {
        const questions = Object.values(request.questions);
        if (questions.some((question) => question.type === "noul")) {
          return model.decide(request);
        }
        throw new LlmError("server down", "server", 503);
      }
    };
    const result = await analyzeWithDecisions(input(300), { client });
    expect(result.warnings.map((warning) => warning.code)).toContain("llm_failed");
  });


  it("定位阶段失败只丢这一段，并留下警告", async () => {
    let call = 0;
    const flaky: DecisionClient = {
      async decide(request) {
        call += 1;
        if (call > 1) throw new Error("timeout");
        return fakeDecisionModel([[100, 150]]).decide(request);
      }
    };
    const result = await analyzeWithDecisions(input(300), { client: flaky });
    expect(result.segments).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain("llm_failed");
  });

  it("取消后抛出，不返回半份结果", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeDecisionModel([[100, 150]]);
    await expect(
      analyzeWithDecisions(input(300), { client, signal: controller.signal })
    ).rejects.toThrow("取消");
  });

  it("时长为零或没有证据时直接返回警告", async () => {
    const client = fakeDecisionModel([]);
    const noDuration = await analyzeWithDecisions({ ...input(0), duration: 0 }, { client });
    expect(noDuration.warnings[0]?.code).toBe("partial");
    const noLines = await analyzeWithDecisions(input(300, []), { client });
    expect(noLines.warnings[0]?.code).toBe("no_context");
    expect(client.calls).toHaveLength(0);
  });

  it("逐段回调，界面可以先画已找到的色块", async () => {
    const client = fakeDecisionModel([[100, 150]]);
    const seen: number[] = [];
    await analyzeWithDecisions(input(300), {
      client,
      onSegment: (segment) => seen.push(segment.start)
    });
    expect(seen).toEqual([100]);
  });

  it("重叠片段合并成一次跳", () => {
    const merged = mergeOverlappingSegments([
      { start: 100, end: 150, kind: "sponsor", confidence: 0.8, evidence: ["a"], reason: "" },
      { start: 140, end: 200, kind: "insert", confidence: 0.9, evidence: ["b"], reason: "" },
      { start: 300, end: 320, kind: "promo", confidence: 0.7, evidence: ["c"], reason: "" }
    ]);
    expect(merged.map((segment) => [segment.start, segment.end])).toEqual([
      [100, 200],
      [300, 320]
    ]);
    expect(merged[0]?.evidence).toEqual(["a", "b"]);
  });
});

describe("mergeOverlappingSegments 的类型取舍", () => {
  it("重叠合并时取置信度更高一方的类型，与排序顺序无关", () => {
    // 顺序一：sponsor 0.8 在前，insert 0.9 在后 → kind 应为 insert。
    const insertFirst = mergeOverlappingSegments([
      { start: 100, end: 150, kind: "sponsor", confidence: 0.8, evidence: ["a"], reason: "" },
      { start: 140, end: 200, kind: "insert", confidence: 0.9, evidence: ["b"], reason: "" }
    ]);
    expect(insertFirst[0]?.kind).toBe("insert");

    // 顺序二：insert 0.9 在前，sponsor 0.8 在后 → kind 仍应为 insert。
    const sponsorFirst = mergeOverlappingSegments([
      { start: 100, end: 150, kind: "insert", confidence: 0.9, evidence: ["b"], reason: "" },
      { start: 140, end: 200, kind: "sponsor", confidence: 0.8, evidence: ["a"], reason: "" }
    ]);
    expect(sponsorFirst[0]?.kind).toBe("insert");
  });
});
