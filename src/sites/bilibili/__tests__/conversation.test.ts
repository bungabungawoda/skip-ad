import { describe, expect, it } from "vitest";
import { parseRoundTable } from "../analysis/conversation";

/** 模型返回的一轮整表；只写本用例关心的字段，其余走归一化默认值。 */
function table(segments: unknown[]): string {
  return JSON.stringify({ segments });
}

function segment(start: number, end: number, kind = "sponsor", status = "closed"): unknown {
  return {
    start,
    end,
    kind,
    status,
    confidence: 0.9,
    evidence: ["口播赞助"]
  };
}

describe("B 站整表解析", () => {
  it("同类型相邻片段合并：间隔 1.5 秒合、1.51 秒不合、跨类型不合", () => {
    const merged = parseRoundTable(
      table([segment(10, 20), segment(21.5, 30)]),
      600,
      600
    );
    expect(merged.segments).toHaveLength(1);
    expect(merged.segments[0]).toMatchObject({ start: 10, end: 30 });

    const beyond = parseRoundTable(
      table([segment(10, 20), segment(21.51, 30)]),
      600,
      600
    );
    expect(beyond.segments).toHaveLength(2);

    const mixed = parseRoundTable(
      table([segment(10, 20, "sponsor"), segment(20, 30, "promo")]),
      600,
      600
    );
    expect(mixed.segments).toHaveLength(2);
    expect(mixed.segments.map((item) => item.kind)).toEqual(["sponsor", "promo"]);
  });

  it("先按已读边界裁剪再合并：合并后只要有一段 open，整段仍是 open", () => {
    // 第二段结尾越过已读边界 25 秒，先被钉成 open；两段间隔 1 秒，再合并。
    const parsed = parseRoundTable(
      table([segment(10, 20), segment(21, 30)]),
      600,
      25
    );
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toMatchObject({ start: 10, end: 25, status: "open" });
  });

  it("起点正好落在已读边界上：本轮跳过，不计入校验丢弃", () => {
    const parsed = parseRoundTable(table([segment(10, 15), segment(20, 30)]), 600, 20);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toMatchObject({ start: 10, end: 15 });
    expect(parsed.dropped).toBe(0);
    expect(parsed.warning).toBeUndefined();
  });

  it("整轮只剩边界片段时不判失败：下一轮会重新给出，不能中断对话", () => {
    const parsed = parseRoundTable(table([segment(20, 30)]), 600, 20);
    expect(parsed.segments).toEqual([]);
    expect(parsed.dropped).toBe(0);
    expect(parsed.error).toBeUndefined();
  });

  it("起点越过已读边界仍然丢弃并计入", () => {
    const parsed = parseRoundTable(table([segment(25, 30)]), 600, 20);
    expect(parsed.segments).toEqual([]);
    expect(parsed.dropped).toBe(1);
    expect(parsed.error).toContain("全部被校验丢弃");
  });

  it("证据与置信度按合并后的区间取并集与最大值", () => {
    const parsed = parseRoundTable(
      table([
        { start: 10, end: 20, kind: "sponsor", status: "closed", confidence: 0.7, evidence: ["a"] },
        { start: 20, end: 30, kind: "sponsor", status: "closed", confidence: 0.9, evidence: ["b"] }
      ]),
      600,
      600
    );
    expect(parsed.segments[0]?.confidence).toBe(0.9);
    expect(parsed.segments[0]?.evidence).toEqual(["a", "b"]);
  });
});
