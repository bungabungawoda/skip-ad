// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController, type SessionControllerCallbacks, type SessionControllerOptions } from "../controller";
import type { AnalysisResult } from "../../analysis/types";
import type {
  Segment,
  SegmentAnalyzer,
  SegmentAnalyzerRun,
  SiteAdapter
} from "../../plugin/types";
import type { PlatformAdAdapter } from "../../platform-ad/types";
import type { RuntimeSettings } from "../../ports/messages";
import { DEFAULT_POLICY } from "../../policy/policy";
import type { SkipStats } from "../../ui/state";
import { sponsorSegment as segment } from "../../../../tests/helpers/segments";
import { makeVideo, tick } from "../../../../tests/helpers/video";
import { LlmError } from "../../ports/llm/client";

/**
 * 会话控制器的行为测试。重点不是内部字段，而是用户在真实页面会看到的结果：
 * 重新分析是否真的发起、旧分析是否串台、站点开关关闭后是否停止跳过。
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function analysisResult(segments: Segment[], durationSec = 600): AnalysisResult {
  return {
    videoKey: "vk",
    video: { site: "youtube", videoId: "BV1", partId: "main" },
    mode: "full",
    segments,
    warnings: [],
    durationSec
  };
}

function makeAdapter(
  video: HTMLVideoElement | null,
  overrides: Partial<SiteAdapter> = {}
): SiteAdapter {
  return {
    resolveVideo: (url) => ({
      site: "youtube",
      videoId: url.searchParams.get("v") ?? "BV1",
      partId: "main"
    }),
    player: { findVideo: () => video },
    pageTitle: () => "测试视频",
    ...overrides
  };
}

interface AnalyzerHarness {
  analyzer: SegmentAnalyzer;
  calls: Array<{ run: SegmentAnalyzerRun; deferred: Deferred<AnalysisResult> }>;
}

function makeDeferredAnalyzer(): AnalyzerHarness {
  const calls: AnalyzerHarness["calls"] = [];
  const analyzer: SegmentAnalyzer = {
    analyze(run) {
      const pending = deferred<AnalysisResult>();
      calls.push({ run, deferred: pending });
      return pending.promise;
    }
  };
  return { analyzer, calls };
}

function makeSettings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    policy: DEFAULT_POLICY,
    llmConfigured: true,
    decisionConfigured: false,
    analysisConfigured: true,
    model: "test-model",
    siteSwitches: {},
    ...overrides
  };
}

let currentSettings: RuntimeSettings;
type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | undefined;
let runtimeListeners: RuntimeListener[];

function installChromeStub(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: { type?: string }) => {
        if (message?.type === "settings.get") {
          return { ok: true, value: currentSettings };
        }
        return { ok: true, value: null };
      }),
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          runtimeListeners.push(listener);
        },
        removeListener: (listener: RuntimeListener) => {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        }
      }
    },
  });
}

function makeController(input: {
  adapter?: SiteAdapter;
  analyzer?: SegmentAnalyzer | null;
  readStats?: () => SkipStats;
  siteId?: string;
  callbacks?: SessionControllerCallbacks;
}): SessionController {
  const options = {
    adapter: input.adapter ?? makeAdapter(null),
    siteId: input.siteId ?? "youtube",
    analyzer: input.analyzer ?? null,
    callbacks: input.callbacks ?? {
      publish: () => {},
      showToast: () => {}
    },
    ...(input.readStats ? { readStats: input.readStats } : {})
  };
  return new SessionController(options as unknown as SessionControllerOptions);
}

/** 后台设置变化时的真实通知路径：内容脚本收到 settings.changed 后重读设置。 */
function notifySettingsChanged(): void {
  for (const listener of runtimeListeners) {
    listener({ type: "settings.changed" }, {}, () => {});
  }
}

async function flushMicrotasks(times = 40): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

beforeEach(() => {
  currentSettings = makeSettings();
  runtimeListeners = [];
  installChromeStub();
  vi.spyOn(window, "setInterval").mockImplementation(
    () => 0 as unknown as ReturnType<typeof window.setInterval>
  );
  window.history.replaceState({}, "", "/watch?v=BV1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("重新分析", () => {
  it("模型给出没结尾的整片广告时按分析失败处理，不展示也不跳", async () => {
    const video = makeVideo(0);
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: {
        // open 片段补到结尾后覆盖整片：模型异常。
        analyze: async () => analysisResult([{ ...segment(0, 100), status: "open" }], 100)
      }
    });
    controller.start({} as never);
    controller.tick();
    await flushMicrotasks();
    const ui = controller.snapshot();
    expect(ui.segments).toEqual([]);
    expect(ui.error?.kind).toBe("invalid_result");
    expect(ui.phase).toBe("failed");
    controller.stop();
  });

  it("内容脚本被接管后，在途重新分析命令不再启动新一轮", async () => {
    const video = makeVideo(60);
    const initialResult = deferred<AnalysisResult>();
    const analyze = vi.fn<SegmentAnalyzer["analyze"]>(() => initialResult.promise);
    const controller = makeController({ adapter: makeAdapter(video), analyzer: { analyze } });
    controller.start({} as never);
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    initialResult.resolve(analysisResult([]));
    await flushMicrotasks();
    expect(analyze).toHaveBeenCalledTimes(1);

    const cacheDelete = deferred<{ ok: true; value: boolean }>();
    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") return { ok: true, value: currentSettings };
      if (request.type === "cache.delete") return cacheDelete.promise;
      return { ok: true, value: null };
    });
    void controller.handleCommand({ type: "ui.command", command: "reanalyze" });
    await flushMicrotasks();

    document.documentElement.dataset.skipadInstance = "newer-instance";
    controller.tick();
    cacheDelete.resolve({ ok: true, value: true });
    await flushMicrotasks();

    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("UI 命令抛错时回复结构化失败，不让 Popup 一直等", async () => {
    const failing = makeController({
      analyzer: null,
      callbacks: {
        publish: () => {
          throw new Error("publish down");
        },
        showToast: () => {}
      }
    });
    failing.start({} as never);
    const listener = runtimeListeners[runtimeListeners.length - 1];
    expect(listener).toBeDefined();
    const failureReply = vi.fn();
    const accepted = listener?.(
      { type: "ui.command", command: "undoSkip" },
      {},
      failureReply
    );
    expect(accepted).toBe(true);
    await flushMicrotasks();
    expect(failureReply).toHaveBeenCalledWith({
      ok: false,
      error: { kind: "internal", message: "publish down" }
    });
    failing.stop();
  });

  it("清缓存失败时不启动新一轮分析，并把原因写进界面", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });
    controller.tick();
    await flushMicrotasks();
    harness.calls[0]?.deferred.resolve(analysisResult([segment(100, 120)]));
    await flushMicrotasks();

    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "cache.delete") {
        return { ok: false, error: { kind: "internal", message: "storage 删除失败" } };
      }
      return { ok: true, value: null };
    });
    await expect(
      controller.handleCommand({ type: "ui.command", command: "reanalyze" })
    ).rejects.toThrow("旧缓存没有清掉，本次没有重新分析；请重试");
    await flushMicrotasks();

    expect(harness.calls).toHaveLength(1);
    expect(controller.snapshot().error?.message).toContain("旧缓存没有清掉");
  });

  it("清缓存失败时命令返回失败，Popup 能显示没生效", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });
    controller.tick();
    await flushMicrotasks();
    harness.calls[0]?.deferred.resolve(analysisResult([segment(100, 120)]));
    await flushMicrotasks();

    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "cache.delete") return { ok: true, value: false };
      if (request.type === "settings.get") return { ok: true, value: currentSettings };
      return { ok: true, value: null };
    });
    const reply = vi.fn();
    controller.start({} as never);
    const active = [...runtimeListeners].at(-1);
    active?.({ type: "ui.command", command: "reanalyze" }, {}, reply);
    await flushMicrotasks();

    expect(reply).toHaveBeenCalledWith({
      ok: false,
      error: { kind: "internal", message: "旧缓存没有清掉，本次没有重新分析；请重试" }
    });
    expect(active).toBeDefined();
  });

  it("清缓存失败后还能重新分析，重试时再次尝试清掉旧缓存", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });
    controller.tick();
    await flushMicrotasks();
    harness.calls[0]?.deferred.resolve(analysisResult([segment(100, 120)]));
    await flushMicrotasks();

    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const deleteCalls: unknown[] = [];
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "cache.delete") {
        deleteCalls.push(request);
        return deleteCalls.length === 1
          ? { ok: false, error: { kind: "internal", message: "storage 删除失败" } }
          : { ok: true, value: true };
      }
      if (request.type === "settings.get") {
        return { ok: true, value: currentSettings };
      }
      return { ok: true, value: null };
    });
    await expect(
      controller.handleCommand({ type: "ui.command", command: "reanalyze" })
    ).rejects.toThrow("旧缓存没有清掉，本次没有重新分析；请重试");
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);
    expect(controller.snapshot().error?.message).toContain("旧缓存没有清掉");
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    await controller.handleCommand({ type: "ui.command", command: "reanalyze" });
    await flushMicrotasks();
    expect(deleteCalls).toHaveLength(2);
    expect(harness.calls).toHaveLength(2);
    expect(controller.snapshot().error).toBeNull();
  });

  it("分析进行中重新分析会真正启动新一轮，旧结果不写回", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    await controller.handleCommand({ type: "ui.command", command: "reanalyze" });
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(2);

    harness.calls[0]?.deferred.resolve(analysisResult([segment(100, 120)]));
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(0);

    harness.calls[1]?.deferred.resolve(analysisResult([segment(200, 220)]));
    await flushMicrotasks();
    expect(controller.snapshot().segments[0]?.segment).toMatchObject({ start: 200, end: 220 });
  });
});

describe("部分结果", () => {
  it("增量结果整表替换，时长沿用已有值不落回 0", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });

    controller.tick();
    await flushMicrotasks();
    const run = harness.calls[0]?.run;
    expect(run).toBeDefined();

    run?.onPartial?.({ segments: [segment(10, 20)], done: 1, total: 2, durationSec: 600, mode: "full" });
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);
    expect(controller.snapshot().durationSec).toBe(600);

    // 模型修订了整表：上一轮的片段消失；没带时长时沿用上一轮的 600，
    // 落回 0 会让覆盖率守卫误判、整段分析期间自动跳全被压住。
    run?.onPartial?.({ segments: [segment(30, 40)], done: 2, total: 2 });
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);
    expect(controller.snapshot().segments[0]?.segment).toMatchObject({ start: 30, end: 40 });
    expect(controller.snapshot().durationSec).toBe(600);
  });
});

describe("平台广告与片段跳过的接线", () => {
  it("平台广告期间不启动视频内分析，广告结束后才发起", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let showingAd = true;
    const adAdapter: PlatformAdAdapter = {
      container: () => container,
      observe: () => ({ showingAd }),
      fastForward: () => ({ acted: false })
    };
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({
      adapter: makeAdapter(video, { createPlatformAdController: () => adAdapter }),
      analyzer: harness.analyzer
    });

    controller.start({} as never);
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    // 广告期间 <video> 的时长是广告的，拿它分析会写出一份 30 秒视频的结果。
    expect(harness.calls).toHaveLength(0);

    showingAd = false;
    notifySettingsChanged();
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);
    controller.stop();
  });

  it("广告期间不执行片段跳过，广告结束后自然跨过起点才跳", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let showingAd = false;
    const adAdapter: PlatformAdAdapter = {
      container: () => container,
      observe: () => ({ showingAd }),
      fastForward: () => ({ acted: true })
    };
    const video = makeVideo(49.0);
    const harness = makeDeferredAnalyzer();
    const showToast = vi.fn();
    const controller = makeController({
      adapter: makeAdapter(video, { createPlatformAdController: () => adAdapter }),
      analyzer: harness.analyzer,
      callbacks: { publish: () => {}, showToast }
    });

    controller.start({} as never);
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    harness.calls[0]?.deferred.resolve(analysisResult([segment(50, 60)]));
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    // 广告出现：后台推 settings.changed，内容脚本重读设置并刷新广告观察。
    showingAd = true;
    notifySettingsChanged();
    await flushMicrotasks();
    // 广告的 timeupdate 也在推进位置：小步进跨过片段起点 50。
    // 暂停中的观察只同步 lastTime：位置停在 50.2，没有 seek 到 60.05。
    tick(video, 48.8);
    tick(video, 50.2);
    expect(video.currentTime).toBe(50.2);
    expect(showToast).not.toHaveBeenCalled();

    // 广告结束回到正片：位置 49.2 只同步 lastTime，自然播放跨过 50 才自动跳。
    showingAd = false;
    notifySettingsChanged();
    await flushMicrotasks();
    tick(video, 49.2);
    tick(video, 50.5);
    expect(video.currentTime).toBe(60.05);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ start: 50, end: 60 }),
      "skipped",
      { end: 60 }
    );
    controller.stop();
  });
});

describe("快照统计", () => {
  it("快照带上内容脚本的本地跳过统计", () => {
    const stats: SkipStats = { skippedCount: 3, skippedSeconds: 42, undoCount: 1 };
    const controller = makeController({ readStats: () => stats });
    expect(controller.snapshot().stats).toEqual(stats);
  });
});

describe("Toast 来源", () => {
  it("手动跳在 Toast 里标记为手动，自动跳保持自动", async () => {
    const video = makeVideo(0);
    const showToast = vi.fn();
    const analyzer: SegmentAnalyzer = {
      analyze: async () => analysisResult([segment(100, 120)])
    };
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer,
      callbacks: {
        publish: () => {},
        showToast
      }
    });

    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    await controller.handleCommand({
      type: "ui.command",
      command: "skipToEnd",
      key: "100.00-120.00"
    });
    expect(showToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 100, end: 120 }),
      "skipped",
      { manual: true }
    );
  });
});

describe("自动跳", () => {
  function skipHarness(seekable: boolean) {
    const video = makeVideo(0);
    let stored = 0;
    Object.defineProperty(video, "currentTime", {
      get: () => stored,
      set: (value: number) => {
        // seekable 为 false 时模拟播放器拒绝跳转：位置保持不动。
        if (seekable) stored = value;
      }
    });
    const showToast = vi.fn();
    const recordSkip = vi.fn();
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: { analyze: async () => analysisResult([segment(100, 120)]) },
      callbacks: { publish: () => {}, showToast }
    });
    controller.onSkipRecorded = recordSkip;
    return { video, controller, showToast, recordSkip, setTime: (value: number) => { stored = value; } };
  }

  async function crossStart(harness: ReturnType<typeof skipHarness>) {
    harness.setTime(99.9);
    tick(harness.video, 99.9);
    harness.setTime(100.1);
    tick(harness.video, 100.1);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  it("跳转生效后才提示已跳过并记统计", async () => {
    const harness = skipHarness(true);
    harness.controller.tick();
    await flushMicrotasks();
    expect(harness.controller.snapshot().segments).toHaveLength(1);

    await crossStart(harness);

    expect(harness.video.currentTime).toBe(120.05);
    expect(harness.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ start: 100, end: 120 }),
      "skipped",
      { end: 120 }
    );
    expect(harness.recordSkip).toHaveBeenCalledTimes(1);
  });

  it("播放器拒绝跳转时不提示已跳过，也不记统计", async () => {
    const harness = skipHarness(false);
    harness.controller.tick();
    await flushMicrotasks();
    expect(harness.controller.snapshot().segments).toHaveLength(1);

    await crossStart(harness);

    expect(harness.showToast).not.toHaveBeenCalled();
    expect(harness.recordSkip).not.toHaveBeenCalled();
  });
});

describe("设置推送", () => {
  it("收到 settings.changed 后重读设置并重新判定已有结果", async () => {
    const video = makeVideo(0);
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: { analyze: async () => analysisResult([segment(100, 120)]) }
    });
    controller.start({} as never);
    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().segments[0]?.policy).toBe("auto");

    currentSettings = {
      ...currentSettings,
      policy: {
        ...currentSettings.policy,
        perKind: { ...currentSettings.policy.perKind, sponsor: "mark" }
      }
    };
    for (const listener of runtimeListeners) {
      listener({ type: "settings.changed" }, {}, () => {});
    }
    await flushMicrotasks();

    // 改成「只标记」类型后，按「标记就要跳」原则不再展示这段片段。
    expect(controller.snapshot().segments).toHaveLength(0);
    expect(controller.snapshot().segments[0]?.policy).toBeUndefined();
    controller.stop();
  });
});

describe("取消与角标", () => {
  it("取消分析后进入已取消态，不再永久显示分析中", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().phase).toBe("analyzing");

    await controller.handleCommand({ type: "ui.command", command: "cancelAnalysis" });
    expect(controller.snapshot().phase).toBe("cancelled");
    expect(controller.snapshot().cancelled).toBe(true);
  });

  it("字幕数据没读到时角标显示 !，不显示 AD 0", async () => {
    const video = makeVideo(0);
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: {
        analyze: async () => ({
          ...analysisResult([]),
          warnings: [{ code: "player_data_unavailable", message: "播放器桥没有响应" }]
        })
      }
    });
    controller.tick();
    await flushMicrotasks();

    const calls = (chrome.runtime.sendMessage as unknown as {
      mock: { calls: Array<[unknown]> };
    }).mock.calls;
    const badge = calls
      .map(([message]) => message as { type?: string; text?: string })
      .filter((message) => message.type === "badge.set")
      .at(-1)?.text;
    expect(badge).toBe("!");
  });
});

describe("切换视频", () => {
  it("地址栏只多了跟踪参数时不重建会话，也不重跑分析", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    // 同一个视频，只是地址多了时间戳参数。
    window.history.pushState({}, "", "/watch?v=BV1&t=42");
    controller.tick();
    await flushMicrotasks();

    expect(harness.calls).toHaveLength(1);
    expect(controller.snapshot().videoId).toBe("BV1");
  });

  it("旧分析的进度不写进切换后的新会话", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);
    const oldRun = harness.calls[0]?.run;

    window.history.pushState({}, "", "/watch?v=BV2");
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(2);

    oldRun?.onProgress?.(99, 100);
    expect(controller.snapshot().progress).toEqual({ done: 0, total: 0 });
  });
});

describe("站点开关", () => {
  interface AdHarness {
    adapter: PlatformAdAdapter;
    container: HTMLElement;
    actions: () => number;
  }

  function makeAdHarness(): AdHarness {
    const container = document.createElement("div");
    document.body.append(container);
    let actions = 0;
    return {
      container,
      adapter: {
        container: () => container,
        observe: () => ({ showingAd: true }),
        fastForward: () => {
          actions += 1;
          return { acted: true };
        }
      },
      actions: () => actions
    };
  }

  function settingsFor(switches: {
    enabled: boolean;
    platformAdSkip: boolean;
    segmentAnalysis: boolean;
  }): RuntimeSettings {
    return makeSettings({
      siteSwitches: {
        youtube: {
          ...switches
        }
      }
    });
  }

  it("站点总开关关闭时平台广告不快进，开启后才快进", async () => {
    const ad = makeAdHarness();
    const adapter = makeAdapter(null, {
      createPlatformAdController: () => ad.adapter
    });
    const controller = makeController({ adapter });

    currentSettings = settingsFor({
      enabled: false,
      platformAdSkip: true,
      segmentAnalysis: false
    });
    controller.start({} as never);
    expect(ad.actions()).toBe(0);
    await flushMicrotasks();
    ad.container.append(document.createElement("span"));
    await flushMicrotasks();
    expect(ad.actions()).toBe(0);

    currentSettings = settingsFor({
      enabled: true,
      platformAdSkip: true,
      segmentAnalysis: true
    });
    const second = makeAdHarness();
    const secondController = makeController({
      adapter: makeAdapter(null, {
        createPlatformAdController: () => second.adapter
      })
    });
    secondController.start({} as never);
    expect(second.actions()).toBe(0);
    await flushMicrotasks();
    expect(second.actions()).toBe(1);
  });

  it("关闭分析开关后，已展示片段不再自动跳", async () => {
    const video = makeVideo(99.9);
    const analyzer: SegmentAnalyzer = {
      analyze: async () => analysisResult([segment(100, 120)])
    };
    const controller = makeController({ adapter: makeAdapter(video), analyzer });

    controller.start({} as never);
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    currentSettings = settingsFor({
      enabled: true,
      platformAdSkip: false,
      segmentAnalysis: false
    });
    notifySettingsChanged();
    await flushMicrotasks();

    expect(controller.snapshot().segments).toHaveLength(0);
    tick(video, 100.1);
    expect(video.currentTime).toBe(100.1);
  });
});

describe("不是广告与停止", () => {
  it("markNotAd 把片段从视图里去掉，并把标记发给后台保存", async () => {
    const video = makeVideo(0);
    const analyzer: SegmentAnalyzer = {
      analyze: async () => analysisResult([segment(100, 120)])
    };
    const controller = makeController({ adapter: makeAdapter(video), analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    await controller.handleCommand({
      type: "ui.command",
      command: "markNotAd",
      key: "100.00-120.00"
    });
    expect(controller.snapshot().segments).toHaveLength(0);

    const send = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    expect(
      send.mock.calls.some((call) => (call[0] as { type: string }).type === "ignore.add")
    ).toBe(true);
  });

  it("stop 之后设置变更不再作用于会话", async () => {
    const video = makeVideo(0);
    const analyzer: SegmentAnalyzer = {
      analyze: async () => analysisResult([segment(100, 120)])
    };
    const controller = makeController({ adapter: makeAdapter(video), analyzer });
    controller.start({} as never);
    await flushMicrotasks();
    controller.tick();
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    controller.stop();
    // 监听已解绑：同样的「关闭分析开关」推送，stop 前会清掉片段，stop 后不再生效。
    currentSettings = makeSettings({
      siteSwitches: { youtube: { enabled: false, platformAdSkip: true, segmentAnalysis: true } }
    });
    notifySettingsChanged();
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(1);

    // 停止后再 tick 不应抛错。
    controller.tick();
  });

  it("stop 会中断在途主分析，迟到的结果不再写回", async () => {
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({ adapter: makeAdapter(video), analyzer: harness.analyzer });
    controller.start({} as never);
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    controller.stop();

    expect(harness.calls[0]?.run.signal.aborted).toBe(true);
    harness.calls[0]?.deferred.resolve(analysisResult([segment(100, 120)]));
    await flushMicrotasks();
    expect(controller.snapshot().segments).toHaveLength(0);
  });
});

describe("跳过与撤销回调", () => {
  it("手动跳与撤销各回调一次，跳过按实际片段时长计", async () => {
    const video = makeVideo(0);
    const skipped: Array<{ start: number; end: number }> = [];
    let undos = 0;
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: { analyze: async () => analysisResult([segment(100, 120)]) }
    });
    controller.onSkipRecorded = (item, skippedEnd) => {
      skipped.push({ start: item.start, end: skippedEnd ?? item.end });
    };
    controller.onUndoRecorded = () => {
      undos += 1;
    };

    controller.tick();
    await flushMicrotasks();

    await controller.handleCommand({
      type: "ui.command",
      command: "skipToEnd",
      key: "100.00-120.00"
    });
    await controller.handleCommand({
      type: "ui.command",
      command: "undoSkip",
      key: "100.00-120.00"
    });

    expect(skipped).toEqual([{ start: 100, end: 120 }]);
    expect(undos).toBe(1);
  });

  it("分析失败时把类别写进界面错误", async () => {
    const video = makeVideo(0);
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: {
        analyze: async () => {
          throw new Error("boom");
        }
      }
    });

    controller.tick();
    await flushMicrotasks();

    expect(controller.snapshot().error).toMatchObject({ kind: "network" });
  });
});

describe("不完整结果", () => {
  function incompleteResult(): AnalysisResult {
    return {
      ...analysisResult([]),
      warnings: [{ code: "partial", message: "1 个分块分析失败" }]
    };
  }

  function setup() {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const video = makeVideo(0);
    const harness = makeDeferredAnalyzer();
    const controller = makeController({
      adapter: makeAdapter(video),
      analyzer: harness.analyzer
    });
    return {
      harness,
      controller,
      advance: (ms: number) => {
        now += ms;
      }
    };
  }

  it("不会自动重跑，等用户手动重新分析", async () => {
    const { harness, controller, advance } = setup();
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);

    harness.calls[0]?.deferred.resolve(incompleteResult());
    await flushMicrotasks();
    expect(controller.snapshot().incomplete).toBe(true);

    advance(60_000);
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);
  });

  it("没有片段且结果不完整时，角标不显示 AD 0", async () => {
    const { harness, controller } = setup();
    const badgeText = (): string | undefined => {
      const calls = (chrome.runtime.sendMessage as unknown as {
        mock: { calls: Array<[unknown, ...unknown[]]> };
      }).mock.calls;
      return calls
        .map(([message]) => message as { type?: string; text?: string })
        .filter((message) => message.type === "badge.set")
        .map((message) => message.text)
        .at(-1);
    };

    controller.tick();
    await flushMicrotasks();
    harness.calls[0]?.deferred.resolve(incompleteResult());
    await flushMicrotasks();
    expect(badgeText()).toBe("!");
  });

  it("已经有片段的结果保留片段，并标出结果不完整", async () => {
    const { harness, controller, advance } = setup();
    controller.tick();
    await flushMicrotasks();

    harness.calls[0]?.deferred.resolve({
      ...incompleteResult(),
      segments: [segment(100, 120)]
    });
    await flushMicrotasks();

    advance(60_000);
    controller.tick();
    await flushMicrotasks();
    expect(harness.calls).toHaveLength(1);
    expect(controller.snapshot().segments).toHaveLength(1);
    expect(controller.snapshot().incomplete).toBe(true);
  });

  it("认证失败停在失败态，手动重新分析才再试", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const video = makeVideo(0);
    let calls = 0;
    const analyzer: SegmentAnalyzer = {
      analyze: async () => {
        calls += 1;
        throw new LlmError("invalid key", "auth");
      }
    };
    const controller = makeController({ adapter: makeAdapter(video), analyzer });

    controller.tick();
    await flushMicrotasks();
    expect(calls).toBe(1);

    // 失败后不会按轮询周期自动重跑，只有用户点重新分析才再试。
    now += 60_000;
    controller.tick();
    await flushMicrotasks();
    expect(calls).toBe(1);

    await controller.handleCommand({ type: "ui.command", command: "reanalyze" });
    await flushMicrotasks();
    expect(calls).toBe(2);
  });
});

