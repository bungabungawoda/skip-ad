import type { Segment, SegmentKind } from "../../src/core/plugin/types";

/** 测试用片段工厂：默认高置信度、带一条证据。 */
export function segment(
  kind: SegmentKind,
  start: number,
  end: number,
  overrides: Partial<Segment> = {}
): Segment {
  return {
    start,
    end,
    kind,
    confidence: 0.9,
    evidence: ["原文"],
    reason: "",
    ...overrides
  };
}

export function sponsorSegment(
  start: number,
  end: number,
  overrides: Partial<Segment> = {}
): Segment {
  return segment("sponsor", start, end, overrides);
}
