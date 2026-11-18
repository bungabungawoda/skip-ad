import { describe, expect, it } from "vitest";
import { buildSequentialChunks, buildSequentialChunksFromCues } from "../planner";
import type { SubtitleCue } from "../../plugin/types";

function cue(start: number, text: string, end = start + 2): SubtitleCue {
  return { start, end, text };
}

describe("连续对话的顺序分块", () => {
  it("600 秒视频切成首尾相接、不重叠的两段", () => {
    expect(buildSequentialChunks(600)).toEqual([
      { index: 0, start: 0, end: 300 },
      { index: 1, start: 300, end: 600 }
    ]);
  });

  it("2385 秒视频：第 5 分钟不再是特殊的截断边界", () => {
    const chunks = buildSequentialChunks(2385);
    expect(chunks[0]).toEqual({ index: 0, start: 0, end: 300 });
    expect(chunks[1]).toEqual({ index: 1, start: 300, end: 600 });
    expect(chunks.at(-1)?.end).toBe(2385);
    // 任意相邻两块都不重叠，也不留缝。
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
    }
  });

  it("空时长与非法时长不产生对话轮次", () => {
    expect(buildSequentialChunks(0)).toEqual([]);
    expect(buildSequentialChunks(Number.NaN)).toEqual([]);
    expect(buildSequentialChunks(120)).toEqual([{ index: 0, start: 0, end: 120 }]);
  });
});

describe("按台词长度取时间范围的分块", () => {
  it("台词装得下时整条视频是一块，块尾延到视频结尾", () => {
    const chunks = buildSequentialChunksFromCues(
      [cue(10, "字".repeat(100)), cue(30, "字".repeat(100))],
      600
    );
    // 块还带本块台词组（跨分组时不漏台词），这里只核对时间范围。
    expect(chunks).toMatchObject([{ index: 0, start: 0, end: 600 }]);
  });

  it("超过字符预算就开新块，块范围首尾相接不重叠", () => {
    const long = "字".repeat(3000);
    const cues = Array.from({ length: 4 }, (_, index) => cue(index * 100 + 5, long));
    const chunks = buildSequentialChunksFromCues(cues, 1000);
    // 每条 3000 字符，6000 预算恰好装两条：两块。
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ index: 0, start: 0 });
    // 第一块终点就是第二块首句起点（205s）；证据包对非最后一块右开，
    // 边界那句台词只属于下一块。
    expect(chunks[0]?.end).toBe(205);
    expect(chunks[1]?.start).toBe(chunks[0]?.end);
    expect(chunks[1]?.end).toBe(1000);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
    }
  });

  it("密集台词的时间范围比 5 分钟短，稀疏台词的更长", () => {
    // 每 1 秒一句、每句 20 字符：6000 字符约装 300 句 ≈ 300 秒以内
    const dense = Array.from({ length: 1200 }, (_, index) => cue(index, "字".repeat(20), index + 1));
    const denseChunks = buildSequentialChunksFromCues(dense, 1200);
    expect(denseChunks.length).toBeGreaterThan(2);
    // 边界精确落在下一块首句起点：第 301 句台词在 t=300。
    expect(denseChunks[0]?.end).toBe(300);

    // 每 60 秒一句、每句 20 字符：6000 字符能装下远超 5 分钟的台词
    const sparse = Array.from({ length: 20 }, (_, index) => cue(index * 60, "字".repeat(20)));
    const sparseChunks = buildSequentialChunksFromCues(sparse, 1200);
    expect(sparseChunks).toHaveLength(1);
    expect(sparseChunks[0]).toMatchObject({ start: 0, end: 1200 });
  });

  it("没有台词不产生分块，调用方退回等时切块", () => {
    expect(buildSequentialChunksFromCues([], 600)).toEqual([]);
  });

  it("同起点台词跨分组时，每块都带自己的台词组，一条不漏", () => {
    // 四条 start=0、各 3000 字：6000 预算恰好两块，两组首句起点相同。
    // 时间区间会重叠，按时间重筛会把第二组整组漏掉，所以块必须自带台词组。
    const cues = Array.from({ length: 4 }, (_, index) => cue(0, `${index}`.repeat(3000), 10));
    const chunks = buildSequentialChunksFromCues(cues, 10);
    expect(chunks).toHaveLength(2);
    const covered = chunks.flatMap((chunk) => chunk.cues ?? []);
    expect(covered).toHaveLength(4);
    expect(new Set(covered).size).toBe(4);
    expect(chunks[0]?.cues).toHaveLength(2);
    expect(chunks[1]?.cues).toHaveLength(2);
  });

  it("非法时长不产生分块", () => {
    expect(buildSequentialChunksFromCues([cue(0, "台词")], 0)).toEqual([]);
    expect(buildSequentialChunksFromCues([cue(0, "台词")], Number.NaN)).toEqual([]);
  });
});
