import { describe, expect, it } from "vitest";
import {
  extractJson,
  mergeAdjacentSegments,
  normalizeSegmentTable
} from "../normalize";

describe("LLM 输出里的 JSON", () => {
  it("从普通文本和代码块里取出 JSON", () => {
    expect(extractJson('```json\n{"segments":[]}\n```')).toEqual({ segments: [] });
    expect(extractJson('结果如下：{"segments":[]} 谢谢')).toEqual({ segments: [] });
    expect(extractJson("不是 JSON")).toBeNull();
  });

  it("跳过思考块里的示例 JSON，保留后面的真正答案", () => {
    const text =
      '<think>We need answer JSON only. Example {"segments":[]} maybe.</think>\n\n{"segments":[{"start":10,"end":20}]}';
    expect(extractJson(text)).toEqual({ segments: [{ start: 10, end: 20 }] });
  });

  it("字符串里的大括号和嵌套对象不会被截断", () => {
    const text = '{"segments":[{"start":1,"end":2,"reason":"台词里有 { 和 } 两个括号"}]}';
    expect(extractJson(text)).toEqual({
      segments: [{ start: 1, end: 2, reason: "台词里有 { 和 } 两个括号" }]
    });
  });

  it("跳过一个坏对象，解析它后面的答案", () => {
    const text = '思考 {不是 JSON} 之后才是答案：{"segments":[{"start":5,"end":9}]}';
    expect(extractJson(text)).toEqual({ segments: [{ start: 5, end: 9 }] });
  });
});

describe("连续对话的整表校验", () => {
  it("把合法片段钳制在视频时长内", () => {
    const result = normalizeSegmentTable(
      {
        segments: [
          {
            start: -5,
            end: 20,
            kind: "sponsor",
            confidence: 0.91,
            evidence: ["本期由 X 赞助"],
            reason: "口播"
          }
        ]
      },
      300
    );
    expect(result.segments[0]).toMatchObject({
      start: 0,
      end: 20,
      kind: "sponsor",
      confidence: 0.91
    });
  });

  it("丢掉颠倒、太短、坐标非法的片段，未知类型归 unknown", () => {
    const result = normalizeSegmentTable(
      {
        segments: [
          { start: 10, end: 5, kind: "sponsor", confidence: 0.9, evidence: ["x"] },
          { start: 30, end: 31, kind: "sponsor", confidence: 0.9, evidence: ["x"] },
          { start: 40, end: 50, kind: "not-a-kind", confidence: 0.9, evidence: ["x"] },
          { start: "60", end: "70", kind: "promo", confidence: "0.8", evidence: [] }
        ]
      },
      600
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe("unknown");
    expect(result.segments[1]?.kind).toBe("promo");
    // 没有证据的片段不能靠模型自报的高置信度混过去。
    expect(result.segments[1]?.confidence).toBe(0.6);
    expect(result.dropped).toBe(2);
  });

  it("精确重复的片段只留一条", () => {
    const item = { start: 10, end: 20, kind: "sponsor", confidence: 0.9, evidence: ["a"] };
    const result = normalizeSegmentTable({ segments: [item, { ...item }] }, 600);
    expect(result.segments).toHaveLength(1);
  });

  it("接受数字字符串，坏数字分别按丢弃、缺省、保留处理", () => {
    const result = normalizeSegmentTable(
      {
        segments: [
          { start: "10.5", end: "20.5", kind: "sponsor", confidence: "0.7", evidence: ["a"] },
          { start: "x", end: "20", kind: "sponsor", confidence: 0.9, evidence: ["a"] },
          { start: "10", end: "20", kind: "sponsor", confidence: "x", evidence: ["a"] }
        ]
      },
      600
    );
    // 整表按起点排序：10 秒那条（confidence 缺省 0.5）在前，10.5 秒那条在后；
    // start 坏掉的那条被丢。
    expect(result.dropped).toBe(1);
    expect(result.segments[0]).toMatchObject({ start: 10, end: 20, confidence: 0.5 });
    expect(result.segments[1]).toMatchObject({ start: 10.5, end: 20.5, confidence: 0.7 });
  });

  it("证据族只保留认识的那些", () => {
    const result = normalizeSegmentTable(
      {
        segments: [
          {
            start: 10,
            end: 20,
            kind: "sponsor",
            confidence: 0.9,
            evidence: ["a"],
            families: ["jump_coordinate", "bad", 3]
          }
        ]
      },
      600
    );
    expect(result.segments[0]?.families).toEqual(["jump_coordinate"]);
  });

  it("裸数组也能当整表读", () => {
    const result = normalizeSegmentTable(
      [{ start: 10, end: 20, kind: "sponsor", confidence: 0.9, evidence: ["a"] }],
      600
    );
    expect(result.segments).toHaveLength(1);
  });

  it("缺 segments 数组时报错，不把它当成「没有广告」", () => {
    expect(normalizeSegmentTable({ answer: "no ads" }, 600).error).toContain(
      "missing segments array"
    );
    expect(normalizeSegmentTable({ segments: "none" }, 600).error).toContain(
      "missing segments array"
    );
  });

  it("校验后合并相邻片段，证据条数封顶 8 条", () => {
    const result = normalizeSegmentTable(
      {
        segments: [
          {
            start: 10,
            end: 20,
            kind: "sponsor",
            confidence: 0.8,
            evidence: ["a", "b", "c", "d", "e"]
          },
          {
            start: 20.5,
            end: 30,
            kind: "sponsor",
            confidence: 0.9,
            evidence: ["f", "g", "h", "i", "j"]
          }
        ]
      },
      600
    );
    const merged = mergeAdjacentSegments(result.segments);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.end).toBe(30);
    expect(merged[0]?.evidence).toHaveLength(8);
  });
});
