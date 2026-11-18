import { describe, expect, it } from "vitest";
import { applyVerify, findNeighbors } from "../verify";
import type { TimelineLine } from "../types";

const lines: TimelineLine[] = [
  { start: 0, end: 10, text: "开场" },
  { start: 92, end: 101, text: "温度控制比上一代好" },
  { start: 101, end: 112, text: "本期视频由赞助商提供" },
  { start: 144, end: 153, text: "链接放在评论区" },
  { start: 153, end: 162, text: "回到正题" }
];

describe("复核的邻居", () => {
  it("取紧挨着片段前后的两句台词", () => {
    const neighbors = findNeighbors(lines, { start: 101, end: 153 });
    expect(neighbors.prev?.text).toBe("温度控制比上一代好");
    expect(neighbors.next?.text).toBe("回到正题");
  });

  it("片段贴到视频开头或结尾时没有对应邻居", () => {
    expect(findNeighbors(lines, { start: 0, end: 10 }).prev).toBeUndefined();
    expect(findNeighbors(lines, { start: 153, end: 162 }).next).toBeUndefined();
  });

  it("弹幕行不参与邻居判断", () => {
    const withNotes: TimelineLine[] = [
      ...lines,
      { start: 154, end: 159, text: "正片开始", kind: "note" }
    ];
    expect(findNeighbors(withNotes, { start: 101, end: 153 }).next?.text).toBe("回到正题");
  });
});

describe("复核结论", () => {
  const base = {
    segment: { start: 101, end: 153 },
    neighbors: findNeighbors(lines, { start: 101, end: 153 }),
    baseConfidence: 0.8,
    wholeThreshold: 0.9,
    neighborThreshold: 0.5
  };

  it("整段是广告、邻居不是：边界不动，置信度不变", () => {
    const outcome = applyVerify({ ...base, answers: { whole: 0.98, prev: 0.04, next: 0.05 } });
    expect(outcome).toMatchObject({
      range: { start: 101, end: 153 },
      confidence: 0.8,
      extended: false
    });
  });

  it("整段概率低于 0.5 直接丢弃", () => {
    expect(applyVerify({ ...base, answers: { whole: 0.2 } })).toBeUndefined();
  });

  it("整段概率低时丢弃：放宽这条会引入误跳，保留现状", () => {
    expect(
      applyVerify({
        ...base,
        baseConfidence: 0.95,
        answers: { whole: 0.448 }
      })
    ).toBeUndefined();
  });

  it("整段概率低且定位置信度也低时继续丢弃，避免把误跳风险变成漏跳补偿", () => {
    expect(
      applyVerify({
        ...base,
        baseConfidence: 0.55,
        answers: { whole: 0.448 }
      })
    ).toBeUndefined();
  });

  it("整段概率在 0.5 到阈值之间：保留但压掉置信度", () => {
    const outcome = applyVerify({ ...base, answers: { whole: 0.7 } });
    expect(outcome?.confidence).toBe(0.7);
  });

  it("前一句也是广告就往前扩一句", () => {
    const outcome = applyVerify({ ...base, answers: { whole: 0.98, prev: 0.9 } });
    expect(outcome?.range.start).toBe(92);
    expect(outcome?.extended).toBe(true);
  });

  it("后一句也是广告就往后扩一句", () => {
    const outcome = applyVerify({ ...base, answers: { whole: 0.98, next: 0.9 } });
    expect(outcome?.range.end).toBe(162);
  });

  it("两侧都扩时一起扩", () => {
    const outcome = applyVerify({ ...base, answers: { whole: 0.98, prev: 0.8, next: 0.8 } });
    expect(outcome?.range).toEqual({ start: 92, end: 162 });
  });

  it("模型给的类别原样带出来，没给就记 unknown", () => {
    expect(applyVerify({ ...base, answers: { whole: 0.98, kind: "insert" } })?.kind).toBe("insert");
    expect(applyVerify({ ...base, answers: { whole: 0.98 } })?.kind).toBe("unknown");
  });
});
