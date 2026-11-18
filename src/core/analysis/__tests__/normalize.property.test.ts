import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeSegmentTable } from "../normalize";
import { EVIDENCE_FAMILIES, SEGMENT_KINDS } from "../../plugin/types";
import { MIN_SEGMENT_SECONDS } from "../../lib/limits";

const rawValue = fc.oneof(
  fc.constant(undefined),
  fc.boolean(),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true }),
  fc.string(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
);

const rawSegment = fc.record({
  start: rawValue,
  end: rawValue,
  kind: rawValue,
  confidence: rawValue,
  evidence: fc.oneof(fc.array(rawValue, { maxLength: 8 }), fc.constant(undefined)),
  reason: rawValue,
  families: fc.oneof(fc.array(rawValue, { maxLength: 8 }), fc.constant(undefined)),
  status: rawValue
});

const segmentTable = fc.array(rawSegment, { maxLength: 20 });
const validKinds = new Set<string>(SEGMENT_KINDS);
const validFamilies = new Set<string>(EVIDENCE_FAMILIES);

describe("片段表归一化的性质", () => {
  it("无论模型返回什么形状，输出都落在可播放、可排序、可重复归一化的范围内", () => {
    fc.assert(
      fc.property(segmentTable, fc.integer({ min: 0, max: 3_600 }), (raw, duration) => {
        const result = normalizeSegmentTable({ segments: raw }, duration);

        expect(result.dropped).toBeGreaterThanOrEqual(0);
        expect(result.segments.length).toBeLessThanOrEqual(raw.length);

        const seen = new Set<string>();
        for (const [index, segment] of result.segments.entries()) {
          expect(Number.isFinite(segment.start)).toBe(true);
          expect(Number.isFinite(segment.end)).toBe(true);
          expect(segment.start).toBeGreaterThanOrEqual(0);
          expect(segment.end).toBeLessThanOrEqual(duration);
          expect(segment.end - segment.start).toBeGreaterThanOrEqual(MIN_SEGMENT_SECONDS);
          expect(segment.confidence).toBeGreaterThanOrEqual(0);
          expect(segment.confidence).toBeLessThanOrEqual(1);
          expect(validKinds.has(segment.kind)).toBe(true);
          expect(segment.families?.every((family) => validFamilies.has(family)) ?? true).toBe(true);
          expect(segment.status === undefined || segment.status === "open" || segment.status === "closed").toBe(true);

          const previous = result.segments[index - 1];
          if (previous) {
            expect(previous.start).toBeLessThanOrEqual(segment.start);
            if (previous.start === segment.start) {
              expect(previous.end).toBeLessThanOrEqual(segment.end);
            }
          }

          const key = `${segment.start}|${segment.end}|${segment.kind}|${segment.status ?? "closed"}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }

        const repeated = normalizeSegmentTable({ segments: result.segments }, duration);
        expect(repeated.segments).toEqual(result.segments);
      }),
      { numRuns: 250 }
    );
  });
});
