import { expect, it } from "vitest";
import { observePlayback, createSkipState } from "../segment-skipper";

it("整片广告标记会把播放跳到结尾", () => {
  const step = observePlayback(
    createSkipState(0),
    { currentTime: 0.3, duration: 150, paused: false, seeking: false, now: 1000 },
    [{ start: 0, end: 150, key: "0.00-150.00" }]
  );
  expect(step.action.type).toBe("seek");
  if (step.action.type === "seek") expect(step.action.to).toBe(150);
});
