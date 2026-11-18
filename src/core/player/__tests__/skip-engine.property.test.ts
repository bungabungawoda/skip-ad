import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSkipState, observePlayback, undoSkip } from "../segment-skipper";

const DURATION = 1_500;

const skipSegment = fc
  .record({
    start: fc.integer({ min: 0, max: 1_000 }),
    length: fc.integer({ min: 3, max: 60 })
  })
  .map(({ start, length }) => {
    const end = Math.min(DURATION, start + length);
    return { start, end, key: `${start.toFixed(2)}-${end.toFixed(2)}` };
  })
  .filter((segment) => segment.end - segment.start >= 3);

const skipSegments = fc
  .uniqueArray(skipSegment, { maxLength: 8, selector: (segment) => segment.key })
  .map((segments) => [...segments].sort((left, right) => left.start - right.start));

describe("跳过状态机的性质", () => {
  it("自动跳只会向前落在有效时长内，并记住本次跨过的全部片段", () => {
    fc.assert(
      fc.property(
        skipSegments,
        fc.integer({ min: 0, max: DURATION }),
        fc.integer({ min: 0, max: DURATION }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 100_000 }),
        (segments, previousTime, currentTime, paused, seeking, suspended, now) => {
          const step = observePlayback(
            createSkipState(previousTime),
            { currentTime, duration: DURATION, paused, seeking, suspended, now },
            segments
          );

          if (paused || seeking || suspended) {
            expect(step.action.type).toBe("none");
            return;
          }
          if (step.action.type !== "seek") return;

          expect(step.action.reason).toBe("skip");
          expect(step.action.to).toBeGreaterThan(currentTime);
          expect(step.action.to).toBeLessThanOrEqual(DURATION);
          expect(step.action.to).toBeGreaterThanOrEqual(step.action.segment.end);
          expect(step.action.keys.length).toBeGreaterThan(0);
          expect(step.action.keys).toContain(step.action.segment.key);
          for (const key of step.action.keys) expect(step.state.skipped[key]).toBe(true);
        }
      ),
      { numRuns: 250 }
    );
  });

  it("保护窗口结束后不会对同一位置重复自动跳", () => {
    fc.assert(
      fc.property(
        skipSegments,
        fc.integer({ min: 0, max: DURATION }),
        fc.integer({ min: 0, max: DURATION }),
        fc.integer({ min: 0, max: 100_000 }),
        (segments, previousTime, currentTime, now) => {
          const observation = {
            currentTime,
            duration: DURATION,
            paused: false,
            seeking: false,
            now
          };
          const first = observePlayback(createSkipState(previousTime), observation, segments);
          if (first.action.type !== "seek") return;

          const later = observePlayback(
            first.state,
            { ...observation, now: first.state.guardUntil + 1 },
            segments
          );
          expect(later.action.type).toBe("none");
        }
      ),
      { numRuns: 250 }
    );
  });

  it("撤销落到调用方给出的非负位置，并停用该片段", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(skipSegment, { minLength: 1, maxLength: 8, selector: (segment) => segment.key }),
        fc.integer({ min: 0, max: DURATION }),
        (segments, target) => {
          const segment = segments[0]!;
          const step = undoSkip(createSkipState(segment.start), segment, 10_000, target);

          expect(step.action).toMatchObject({ type: "seek", reason: "undo", to: target });
          expect(step.state.lastTime).toBe(target);
          expect(step.state.skipped[segment.key]).toBe(true);
        }
      ),
      { numRuns: 250 }
    );
  });
});
