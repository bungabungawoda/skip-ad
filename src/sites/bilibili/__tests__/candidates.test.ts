import { describe, expect, it } from "vitest";
import { deriveCandidates } from "../analysis/candidates";
import { buildSignals } from "../analysis/signals";
import type { SignalSet } from "../analysis/signals";

function signals(overrides: Partial<SignalSet> = {}): SignalSet {
  return {
    jumpTargets: [],
    adWordHits: [],
    divergentTerms: [],
    ctaHits: [],
    chapterHits: [],
    novelty: [],
    repeat: [],
    densitySpikes: [],
    boundaries: [],
    ...overrides
  };
}

describe("deriveCandidates", () => {
  it("creates a window around a jump coordinate with enough votes", () => {
    const result = deriveCandidates(
      signals({ jumpTargets: [{ time: 120, votes: 3 }] }),
      300
    );
    expect(result).toHaveLength(1);
    // 120s 落在第 8 个 15 秒桶 [120,135)，窗口再外扩 10 秒：[110,145]。
    expect(result[0]?.start).toBe(110);
    expect(result[0]?.end).toBe(145);
    expect(result[0]?.arms).toContain("jump_coordinate");
  });

  it("requires at least two ad-word hits in a bin", () => {
    const one = deriveCandidates(
      signals({ adWordHits: [{ time: 200, phrase: "广告", text: "广告" }] }),
      300
    );
    expect(one).toHaveLength(0);
    const two = deriveCandidates(
      signals({
        adWordHits: [
          { time: 200, phrase: "广告", text: "广告" },
          { time: 202, phrase: "恰饭", text: "恰饭" }
        ]
      }),
      300
    );
    expect(two).toHaveLength(1);
  });

  it("merges adjacent bins and respects the candidate limit", () => {
    const result = deriveCandidates(
      signals({
        adWordHits: [
          ...Array.from({ length: 10 }, (_, index) => ({
            time: 100 + index * 0.2,
            phrase: "广告",
            text: "广告"
          })),
          ...Array.from({ length: 10 }, (_, index) => ({
            time: 130 + index * 0.2,
            phrase: "恰饭",
            text: "恰饭"
          }))
        ],
        jumpTargets: [{ time: 160, votes: 2 }]
      }),
      300,
      1
    );
    expect(result).toHaveLength(1);
  });

  it("returns nothing for an empty signal set", () => {
    expect(deriveCandidates(signals(), 300)).toEqual([]);
    expect(deriveCandidates(signals(), 0)).toEqual([]);
  });

  it("expands a chapter hit across the bins it covers", () => {
    const result = deriveCandidates(
      signals({ chapterHits: [{ start: 30, end: 75, title: "广告" }] }),
      300
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.arms).toContain("chapter");
    // 30–75 秒覆盖 15 秒桶 2、3、4，窗口前后各留 10 秒。
    expect(result[0]?.start).toBe(20);
    expect(result[0]?.end).toBe(85);
  });
});

describe("候选窗口的组成项", () => {
  it("按票数累计空降票，其余按命中条数计", () => {
    const result = deriveCandidates(
      signals({
        jumpTargets: [{ time: 100, votes: 3 }],
        adWordHits: [
          { time: 101, phrase: "广告", text: "广告" },
          { time: 102, phrase: "恰饭", text: "恰饭" }
        ]
      }),
      300
    );
    expect(result[0]?.parts).toMatchObject({ jump: 3, adWord: 2 });
  });
});

describe("合并后的坐标票", () => {
  it("31:57 与 31:58 合并成两票后能生成候选窗口", () => {
    const signals = buildSignals({
      title: "",
      description: "",
      duration: 2400,
      cues: [],
      danmaku: [
        { time: 5, mode: 1, text: "指路31：57" },
        { time: 6, mode: 1, text: "part在31:58" }
      ],
      chapters: []
    });
    const result = deriveCandidates(signals, 2400);
    expect(result.some((candidate) => candidate.parts.jump === 2)).toBe(true);
  });
});
