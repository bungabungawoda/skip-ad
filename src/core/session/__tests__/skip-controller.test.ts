// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkipController } from "../skip-controller";
import { sponsorSegment } from "../../../../tests/helpers/segments";
import { makeVideo, tick } from "../../../../tests/helpers/video";

const SKIP_VERIFY_WAIT_MS = 500;

async function confirmSkip(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SKIP_VERIFY_WAIT_MS);
}

function setup(options: { suspended?: boolean } = {}) {
  const segment = sponsorSegment(10, 20);
  const onAutoSkip = vi.fn();
  const onAfterSeek = vi.fn();
  const skip = new SkipController({
    suspended: () => options.suspended ?? false,
    resolveSegment: () => segment,
    onAutoSkip,
    onAfterSeek
  });
  const video = makeVideo(9);
  skip.bind(video);
  skip.setAuto([{ start: segment.start, end: segment.end, key: "10.00-20.00" }]);
  return { skip, video, segment, onAutoSkip, onAfterSeek };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SkipController", () => {
  it("相邻片段并进同一次跳转时，回调带上实际落点", async () => {
    const first = sponsorSegment(10, 20);
    const second = sponsorSegment(20.5, 30);
    const onAutoSkip = vi.fn();
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: (key) =>
        key === "10.00-20.00" ? first : key === "20.50-30.00" ? second : undefined,
      onAutoSkip,
      onAfterSeek: () => {}
    });
    const video = makeVideo(9);
    skip.bind(video);
    skip.setAuto([
      { start: 10, end: 20, key: "10.00-20.00" },
      { start: 20.5, end: 30, key: "20.50-30.00" }
    ]);

    tick(video, 10.2);
    expect(video.currentTime).toBe(30.05);
    await confirmSkip();
    expect(onAutoSkip).toHaveBeenCalledWith({ segment: first, to: 30.05 });
  });

  it("自然播放跨过起点时跳到结尾并回调", async () => {
    const { video, onAutoSkip, onAfterSeek } = setup();
    tick(video, 10.2);
    expect(video.currentTime).toBe(20.05);
    // 跳转要等一轮确认播放器真的接受了，才回调「已跳过」。
    await confirmSkip();
    expect(onAutoSkip).toHaveBeenCalledTimes(1);
    expect(onAfterSeek).toHaveBeenCalledTimes(1);
  });

  it("播放器拒绝跳转时不回调已跳过", async () => {
    const { skip, video, onAutoSkip } = setup();
    let stored = 9.9;
    Object.defineProperty(video, "currentTime", {
      get: () => stored,
      set: () => {
        // 播放器拒绝这次 seek，位置保持不动
      },
      configurable: true
    });
    stored = 10.2;
    video.dispatchEvent(new Event("timeupdate"));
    await confirmSkip();
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(stored).toBe(10.2);
    expect(skip.currentState.skipped["10.00-20.00"]).toBeUndefined();
  });

  it("dispose 之后不再响应播放器事件", () => {
    const { skip, video, onAutoSkip } = setup();
    skip.dispose();
    tick(video, 10.2);
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10.2);
  });

  it("暂停时只同步播放位置，不跳", () => {
    const { video, onAutoSkip } = setup();
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    tick(video, 10.2);
    expect(video.currentTime).toBe(10.2);
    expect(onAutoSkip).not.toHaveBeenCalled();
  });

  it("短暂停顿后继续播放，起点前的跨越仍然触发跳过", async () => {
    const { video, onAutoSkip } = setup();
    Object.defineProperty(video, "paused", { value: true, configurable: true, writable: true });
    video.dispatchEvent(new Event("pause"));
    Object.defineProperty(video, "paused", { value: false, configurable: true, writable: true });
    video.dispatchEvent(new Event("play"));
    tick(video, 10.2);
    expect(video.currentTime).toBe(20.05);
    await confirmSkip();
    expect(onAutoSkip).toHaveBeenCalledTimes(1);
  });

  it("平台广告期间挂起，不跳", () => {
    const { video, onAutoSkip } = setup({ suspended: true });
    tick(video, 10.2);
    expect(video.currentTime).toBe(10.2);
    expect(onAutoSkip).not.toHaveBeenCalled();
  });

  it("时长无效时不跳", () => {
    const { video, skip, onAutoSkip } = setup();
    Object.defineProperty(video, "duration", { value: Number.NaN, configurable: true });
    tick(video, 10.2);
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10.2);
    expect(skip.currentState.skipped["10.00-20.00"]).toBeUndefined();
  });

  it("撤销后本次播放不再自动跳该片段，拖回起点之前才恢复", async () => {
    const { skip, video, segment, onAutoSkip } = setup();
    expect(skip.manualSkip(segment)).toBe(true);
    expect(video.currentTime).toBe(20.05);

    expect(skip.undo(segment)).toBe(9);
    expect(video.currentTime).toBe(9);

    // 撤销后继续播放进入片段：不自动跳。
    await vi.advanceTimersByTimeAsync(1_100);
    tick(video, 10.2);
    expect(onAutoSkip).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10.2);

    // 拖回片段起点之前再进入：恢复自动跳。
    tick(video, 8);
    tick(video, 9);
    tick(video, 10.2);
    expect(video.currentTime).toBe(20.05);
  });

  it("合并跳转被播放器拒绝时，整组跳过标记都要回滚", async () => {
    const first = sponsorSegment(10, 20);
    const second = sponsorSegment(20.5, 30);
    const onAutoSkip = vi.fn();
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: (key) => (key === "10.00-20.00" ? first : key === "20.50-30.00" ? second : undefined),
      onAutoSkip,
      onAfterSeek: () => {}
    });
    const video = makeVideo(9);
    let allowSeek = false;
    let stored = 9;
    Object.defineProperty(video, "currentTime", {
      get: () => stored,
      set: (value: number) => {
        if (allowSeek) stored = value;
      },
      configurable: true
    });
    skip.bind(video);
    skip.setAuto([
      { start: 10, end: 20, key: "10.00-20.00" },
      { start: 20.5, end: 30, key: "20.50-30.00" }
    ]);

    // 第一次跨过第一段：合并了两段，但播放器拒绝跳转。
    stored = 10.2;
    tick(video, 10.2);
    await confirmSkip();
    expect(skip.currentState.skipped["10.00-20.00"]).toBeUndefined();
    expect(skip.currentState.skipped["20.50-30.00"]).toBeUndefined();

    // 继续自然播放跨过第二段起点：这一段必须还能单独触发，不能永久漏跳。
    allowSeek = true;
    stored = 20.4;
    tick(video, 20.4);
    stored = 20.6;
    tick(video, 20.6);
    expect(video.currentTime).toBe(30.05);
    // 跳转要等一轮确认播放器真的接受了，才回调「已跳过」。
    await confirmSkip();
    expect(onAutoSkip).toHaveBeenCalledWith({ segment: second, to: 30.05 });
  });

  it("没有跳转记录时撤销不生效", () => {
    const { skip, video, segment } = setup();
    video.currentTime = 15;
    const before = video.currentTime;
    expect(skip.undo(segment)).toBeNull();
    expect(video.currentTime).toBe(before);
  });

  it("在广告中间手动跳，撤销回到广告中间", () => {
    const { skip, video, segment } = setup();
    video.currentTime = 15;
    expect(skip.manualSkip(segment)).toBe(true);
    expect(video.currentTime).toBe(20.05);

    expect(skip.undo(segment)).toBe(15);
    expect(video.currentTime).toBe(15);
  });

  it("自动跳撤销回到跳转发生前的实际位置", async () => {
    const { skip, video, segment } = setup();
    video.currentTime = 9.5;
    tick(video, 10.2);
    expect(video.currentTime).toBe(20.05);
    await confirmSkip();

    expect(skip.undo(segment)).toBe(10.2);
    // 自动跳是在位置跨到 10.2 时触发的，撤销回到触发前的实际位置。
    expect(video.currentTime).toBe(10.2);
  });

  it("倍速播放后位置走远，撤销仍回到跳转前的位置", () => {
    const { skip, video, segment } = setup();
    video.currentTime = 15;
    expect(skip.manualSkip(segment)).toBe(true);
    video.currentTime = segment.end + 6;
    expect(skip.undo(segment)).toBe(15);
    expect(video.currentTime).toBe(15);
  });

  it("没有绑定播放器时手动跳返回 false、撤销返回 null", () => {
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: () => undefined,
      onAutoSkip: () => {},
      onAfterSeek: () => {}
    });
    expect(skip.manualSkip(sponsorSegment(10, 20))).toBe(false);
    expect(skip.undo(sponsorSegment(10, 20))).toBeNull();
  });
});

describe("播放器替换", () => {
  it("绑定新播放器时摘掉旧播放器的监听", () => {
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: () => undefined,
      onAutoSkip: () => {},
      onAfterSeek: () => {}
    });
    const first = makeVideo(0);
    const second = makeVideo(0);
    const remove = vi.spyOn(first, "removeEventListener");
    skip.bind(first);
    skip.bind(second);

    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
      "pause",
      "play",
      "seeked",
      "timeupdate"
    ]);
    // 旧元素不再影响会话：它触发的 timeupdate 不该改当前状态。
    expect(skip.currentVideo).toBe(second);
  });

  it("同一个元素重复绑定不会叠加监听", () => {
    const skip = new SkipController({
      suspended: () => false,
      resolveSegment: () => undefined,
      onAutoSkip: () => {},
      onAfterSeek: () => {}
    });
    const video = makeVideo(0);
    const add = vi.spyOn(video, "addEventListener");
    skip.bind(video);
    skip.bind(video);
    expect(add).toHaveBeenCalledTimes(4);
  });
});
