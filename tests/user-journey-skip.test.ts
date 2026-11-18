// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../src/sites/bilibili/analysis/analyzer";
import { DEFAULT_POLICY, evaluateSegments } from "../src/core/policy/policy";
import { SkipController } from "../src/core/session/skip-controller";
import { cues300, makeClient, makeDeps, makeLlm } from "./helpers/analysis";
import { makeVideo, tick } from "./helpers/video";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("用户观看流程", () => {
  it("从模型判定到自动跳过，再撤销并重看同一段", async () => {
    const client = makeClient({
      getSubtitle: vi.fn(async () => cues300)
    });
    const analysis = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client,
        llm: makeLlm(
          '{"segments":[{"start":90,"end":120,"kind":"sponsor","confidence":0.92,"evidence":["本期视频由赞助商提供"],"reason":"口播赞助"}]}'
        )
      })
    );

    const policy = evaluateSegments(analysis.segments, analysis.durationSec, DEFAULT_POLICY, analysis.mode);
    expect(policy.auto).toHaveLength(1);

    const segment = policy.auto[0]!;
    const onAutoSkip = vi.fn();
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: (key) => (key === "90.00-120.00" ? segment : undefined),
      onAutoSkip,
      onAfterSeek: () => {}
    });
    const video = makeVideo(89, 300);
    skip.bind(video);
    skip.setAuto([{ start: segment.start, end: segment.end, key: "90.00-120.00" }]);

    tick(video, 90.2);
    expect(video.currentTime).toBe(120.05);
    await vi.advanceTimersByTimeAsync(500);
    expect(onAutoSkip).toHaveBeenCalledWith({ segment, to: 120.05 });

    expect(skip.undo(segment)).toBe(90.2);
    expect(video.currentTime).toBe(90.2);

    await vi.advanceTimersByTimeAsync(1_100);
    tick(video, 100);
    expect(video.currentTime).toBe(100);
    expect(onAutoSkip).toHaveBeenCalledTimes(1);
  });
});
