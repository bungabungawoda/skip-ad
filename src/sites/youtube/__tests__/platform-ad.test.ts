// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformAdController } from "../../../core/platform-ad/controller";
import { createYouTubeAdapter } from "../adapter";
import { findPlayerContainer } from "../platform-ad";

/**
 * DOM 夹具测试：YouTube 平台广告快进（seek 优先、16 倍速兜底）。
 * 覆盖：无广告、seek 生效不碰倍速、时长未就绪先等后兜底、seekable 为空、
 * seek 被弹回、seek 生效但拖着不收尾、倍速重置后重挂、pod 换广告（含兜底中
 * 恢复自然状态再 seek）、播放器替换、停止后不再维护、SPA 导航。
 *
 * 背景：content script 的 click() 产生 isTrusted=false 事件，YouTube 播放器
 * 判为异常，点击路线在真实页面永远无效；快进路线已在真机 E2E 验证。
 */

function mountPlayer(): {
  container: HTMLElement;
  video: HTMLVideoElement;
} {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  container.id = "movie_player";
  const video = document.createElement("video");
  video.className = "html5-main-video";
  container.append(video);
  document.body.append(container);
  return { container, video };
}

/** happy-dom 的 media 元素没有时长与 seekable 概念：用自身属性覆盖出可控的值。 */
function setDuration(video: HTMLVideoElement, value: number): void {
  Object.defineProperty(video, "duration", {
    value,
    configurable: true,
    writable: false
  });
}

function setSeekable(video: HTMLVideoElement, ranges: Array<[number, number]>): void {
  Object.defineProperty(video, "seekable", {
    configurable: true,
    value: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0
    }
  });
}

function makeController(options: { onSkip?: (seconds?: number) => void } = {}) {
  const adapter = createYouTubeAdapter();
  const adAdapter = adapter.createPlatformAdController?.();
  if (!adAdapter) throw new Error("YouTube 适配器必须提供平台广告端口");
  let nowMs = 1_000;
  const controller = createPlatformAdController(adAdapter, {
    now: () => nowMs,
    ...(options.onSkip ? { onSkip: options.onSkip } : {})
  });
  created.push(controller);
  return {
    controller,
    adapter,
    elapse: (ms: number) => {
      nowMs += ms;
    },
    refresh: () => controller.refresh()
  };
}

/** document 级监听在用例间共享：用例结束必须 dispose，避免互相干扰。 */
const created: ReturnType<typeof createPlatformAdController>[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const controller of created.splice(0)) controller.stop();
});

describe("平台广告快进 DOM 夹具", () => {
  it("无广告：不动作，不暂停正片片段", () => {
    const { video } = mountPlayer();
    setDuration(video, 300);
    setSeekable(video, [[0, 300]]);
    video.currentTime = 120;
    const { controller, refresh } = makeController();
    refresh();
    expect(controller.snapshot()).toMatchObject({ phase: "no_ad", attempts: 0 });
    expect(controller.shouldSuspendSegments()).toBe(false);
    expect(video.currentTime).toBe(120);
    expect(video.playbackRate).toBe(1);
  });

  it("时长与 seekable 就绪：seek 到片尾，不碰倍速与静音", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.currentTime).toBeCloseTo(14.99, 2);
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "fast_forwarding", attempts: 1 });
    // 已 seek 到片尾、广告还没收尾：不再动作。
    elapse(400);
    refresh();
    expect(controller.snapshot().phase).toBe("waiting");
    expect(controller.snapshot().attempts).toBe(1);
    // 广告结束：正片的播放位置与播放状态都不受影响。
    container.classList.remove("ad-showing");
    refresh();
    expect(video.currentTime).toBeCloseTo(14.99, 2);
    expect(video.playbackRate).toBe(1);
  });

  it("seek 时按广告剩余时长记录跳过", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    const skips: Array<number | undefined> = [];
    const { refresh } = makeController({ onSkip: (seconds) => skips.push(seconds) });
    refresh();
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    refresh();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toBeCloseTo(14.44, 2);
  });

  it("倍速兜底按 16 倍速折算节省时间", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const skips: Array<number | undefined> = [];
    const { refresh, elapse } = makeController({ onSkip: (seconds) => skips.push(seconds) });
    video.currentTime = 1.5;
    refresh();
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(skips).toHaveLength(1);
    // 剩余 13.54 秒，16 倍速下省下 15/16。
    expect(skips[0]).toBeCloseTo(12.69, 2);
  });

  it("媒体还没真正开播（ct≤0.5）：不 seek，先等", () => {    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    container.classList.add("ad-showing");
    const { controller, refresh } = makeController();
    refresh();
    expect(video.currentTime).toBe(0);
    expect(controller.snapshot()).toMatchObject({ phase: "waiting", attempts: 0 });
  });

  it("时长未就绪：先等待，广告走过 1 秒仍无时长才倍速兜底", () => {
    const { container, video } = mountPlayer();
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "waiting", attempts: 0 });
    expect(controller.shouldSuspendSegments()).toBe(true);
    // 广告已在走而时长一直拿不到：倍速兜底。
    video.currentTime = 1.5;
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);
    expect(controller.snapshot()).toMatchObject({ phase: "fast_forwarding", attempts: 1 });
    // 广告结束：恢复快进前的倍速与静音。
    container.classList.remove("ad-showing");
    refresh();
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
  });

  it("seekable 为空（不可 seek 的广告）：走过 1 秒后倍速兜底", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.playbackRate).toBe(1);
    expect(video.currentTime).toBe(0);
    video.currentTime = 1.5;
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);
    expect(video.currentTime).toBe(1.5);
    expect(controller.snapshot().attempts).toBe(1);
    container.classList.remove("ad-showing");
    refresh();
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
  });

  it("seek 被弹回：同一步转倍速兜底，本条媒体不再 seek", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.currentTime).toBeCloseTo(14.99, 2);
    // 模拟播放器把 seek 弹回片头。
    video.currentTime = 0;
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);
    expect(controller.snapshot().attempts).toBe(2);
    // 弹回后不再 seek：currentTime 不再被推到片尾。
    elapse(400);
    refresh();
    expect(video.currentTime).toBe(0);
    expect(controller.snapshot().attempts).toBe(2);
    // 广告结束：恢复倍速与静音。
    container.classList.remove("ad-showing");
    refresh();
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
  });

  it("seek 生效但广告拖着不收尾：多个观察步后转倍速兜底", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.currentTime).toBeCloseTo(14.99, 2);
    // seek 已生效但 YouTube 不结束广告：三个观察步后转兜底。
    for (let index = 0; index < 3; index += 1) {
      elapse(400);
      refresh();
    }
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);
    expect(controller.snapshot().attempts).toBe(2);
  });

  it("倍速被播放器重置：ratechange 事件里立即重挂", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    video.currentTime = 1.5;
    refresh();
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(controller.snapshot().attempts).toBe(1);
    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    expect(video.playbackRate).toBe(16);
    expect(controller.snapshot().attempts).toBe(1);
  });

  it("停止后不再维护倍速：dispose 移除事件监听", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    video.currentTime = 1.5;
    refresh();
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    controller.stop();
    video.playbackRate = 1;
    video.dispatchEvent(new Event("ratechange"));
    expect(video.playbackRate).toBe(1);
  });

  it("停止时恢复快进前的倍速和静音", () => {
    const { container, video } = mountPlayer();
    video.playbackRate = 1.5;
    video.muted = false;
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    video.currentTime = 1.5;
    refresh();
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);

    controller.stop();

    expect(video.playbackRate).toBe(1.5);
    expect(video.muted).toBe(false);
  });

  it("pod 换广告（时长变化）：重新 seek 下一条广告，全程不碰倍速", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 30.02]]);
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    const { controller, refresh, elapse } = makeController();
    refresh();
    expect(video.currentTime).toBeCloseTo(14.99, 2);
    // 下一条广告：换媒体、时长不同、从头播。
    setDuration(video, 30.02);
    video.currentTime = 0.6;
    elapse(400);
    refresh();
    expect(video.currentTime).toBeCloseTo(29.97, 2);
    expect(video.playbackRate).toBe(1);
    expect(controller.snapshot().attempts).toBe(2);
  });

  it("pod 内同长度广告连播：位置回到片头也算换广告，继续 seek", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, [[0, 15.04]]);
    container.classList.add("ad-showing");
    video.currentTime = 0.6;
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { controller, refresh, elapse } = makeController();
      refresh();
      expect(video.currentTime).toBeCloseTo(14.99, 2);

      // 2.1 秒后换了下一条同长度广告：duration 不变，但播放位置回到片头。
      now += 2_100;
      elapse(2_100);
      video.currentTime = 0.6;
      refresh();
      expect(video.currentTime).toBeCloseTo(14.99, 2);
      expect(controller.snapshot().attempts).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("pod 内兜底已挂：换广告出现 seek 机会时先恢复自然状态再 seek", () => {
    const { container, video } = mountPlayer();
    setDuration(video, 15.04);
    setSeekable(video, []);
    container.classList.add("ad-showing");
    const { controller, refresh, elapse } = makeController();
    video.currentTime = 1.5;
    refresh();
    elapse(400);
    refresh();
    expect(video.playbackRate).toBe(16);
    expect(video.muted).toBe(true);
    // 下一条广告可 seek：先撤兜底再 seek。
    setDuration(video, 30.02);
    setSeekable(video, [[0, 30.02]]);
    video.currentTime = 0.6;
    elapse(400);
    refresh();
    expect(video.currentTime).toBeCloseTo(29.97, 2);
    expect(video.playbackRate).toBe(1);
    expect(video.muted).toBe(false);
    expect(controller.snapshot().attempts).toBe(2);
  });

  it("播放器被替换：观察重新绑定新容器，快进发生在新 video 上", () => {
    const first = mountPlayer();
    setDuration(first.video, 15.04);
    setSeekable(first.video, [[0, 15.04]]);
    first.container.classList.add("ad-showing");
    first.video.currentTime = 0.6;
    const { refresh, controller } = makeController();
    refresh();
    expect(first.video.currentTime).toBeCloseTo(14.99, 2);
    expect(controller.snapshot().attempts).toBe(1);

    document.body.innerHTML = "";
    const second = mountPlayer();
    setDuration(second.video, 30.02);
    setSeekable(second.video, [[0, 30.02]]);
    second.container.classList.add("ad-showing");
    second.video.currentTime = 0.6;
    refresh();
    expect(second.video.currentTime).toBeCloseTo(29.97, 2);
    expect(controller.snapshot().attempts).toBe(1);
    expect(findPlayerContainer()).toBe(second.container);
  });

  it("广告在播时播放器缺失：暂停正片片段，不动作", () => {
    mountPlayer();
    const { controller, refresh } = makeController();
    refresh();
    // 播放器被移除：观察为未知，保持当前相位，正片片段暂停。
    document.body.innerHTML = "";
    refresh();
    expect(controller.shouldSuspendSegments()).toBe(true);
  });
});

describe("SPA 导航", () => {
  it("yt-navigate-finish 触发回调；VideoKey 随 v 参数切换", async () => {
    const { adapter } = makeController();
    const onChange = vi.fn();
    const disposable = adapter.observeNavigation?.(onChange);
    document.dispatchEvent(new CustomEvent("yt-navigate-finish"));
    expect(onChange).toHaveBeenCalledTimes(1);
    disposable?.dispose();
    document.dispatchEvent(new CustomEvent("yt-navigate-finish"));
    expect(onChange).toHaveBeenCalledTimes(1);

    const before = adapter.resolveVideo(new URL("https://www.youtube.com/watch?v=aaa"));
    const after = adapter.resolveVideo(new URL("https://www.youtube.com/watch?v=bbb"));
    expect(before).toEqual({ site: "youtube", videoId: "aaa", partId: "main" });
    expect(after).toEqual({ site: "youtube", videoId: "bbb", partId: "main" });
  });
});
