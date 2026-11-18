import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import { analyzeVideoWithDecision } from "../analysis/decision-analyzer";
import { openEvidence } from "../analysis/evidence-loader";
import { createStorageCache } from "../../../core/ports/cache/store";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { cues, danmaku, makeClient, makeDeps, track } from "../../../../tests/helpers/analysis";
import { fakeDecisionModel } from "../../../../tests/helpers/decision";

/**
 * 证据取数的两条性能约定：
 * 1. 弹幕与播放器/字幕同时发出，不排成串行；
 * 2. 同一次分析里，连续对话链路与决策链路共用同一份证据，站点请求不翻倍。
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** 让已经排队的微任务全部跑完：被门挡住的请求会停住，没被挡的会继续。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("证据取数", () => {
  it("弹幕请求与播放器/字幕同时发出，登录门未开就已经在拉", async () => {
    const playerGate = deferred<void>();
    const client = makeClient({
      getPlayer: vi.fn(async () => {
        await playerGate.promise;
        return { isLogin: true, subtitles: [track], chapters: [] };
      })
    });

    const pending = analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ client }));
    await flushMicrotasks();
    // 播放器还卡着，弹幕已经发出去了。
    expect(client.getDanmaku).toHaveBeenCalledTimes(1);

    playerGate.resolve();
    await pending;
    expect(client.getPlayer).toHaveBeenCalledTimes(1);
  });

  it("连续对话链路与决策链路共用一次取数与一次信号计算", async () => {
    const client = makeClient();
    const signal = new AbortController().signal;
    const cache = () => createStorageCache(createMemoryStorageArea(), () => 1_000);

    await Promise.all([
      analyzeVideo(
        { bvid: "BV1test", page: 1 },
        { ...makeDeps({ client }), signal, cache: cache() }
      ),
      analyzeVideoWithDecision(
        { bvid: "BV1test", page: 1 },
        {
          client,
          decision: fakeDecisionModel([[90, 120]]),
          cache: cache(),
          policy: DEFAULT_POLICY,
          promptVersion: "d2",
          model: "gemini-decision-1",
          now: () => 1_000,
          signal
        }
      )
    ]);

    expect(client.getVideo).toHaveBeenCalledTimes(1);
    expect(client.getPlayer).toHaveBeenCalledTimes(1);
    expect(client.getDanmaku).toHaveBeenCalledTimes(1);
    expect(client.getSubtitle).toHaveBeenCalledTimes(1);
  });

  it("换一次分析的取消信号就重新取数", async () => {
    const client = makeClient();
    const run = (signal: AbortSignal) =>
      analyzeVideo(
        { bvid: "BV1test", page: 1 },
        {
          ...makeDeps({ client }),
          signal,
          cache: createStorageCache(createMemoryStorageArea(), () => 1_000)
        }
      );

    await run(new AbortController().signal);
    await run(new AbortController().signal);
    expect(client.getVideo).toHaveBeenCalledTimes(2);
    expect(client.getDanmaku).toHaveBeenCalledTimes(2);
  });

  it("证据包只把同一次分析的两次调用并成一份", async () => {
    const client = makeClient();
    const signal = new AbortController().signal;
    const deps = { client, signal, sleep: async () => undefined };

    const first = openEvidence({ bvid: "BV1test", page: 1 }, deps);
    const video = await first.video;
    expect(video.cid).toBe(42);
    // 同一个包内重复取字幕不会重新请求。
    await first.subtitle();
    await first.subtitle();
    expect(client.getPlayer).toHaveBeenCalledTimes(1);
    expect(client.getSubtitle).toHaveBeenCalledTimes(1);
    // 弹幕与字幕都在第一次 subtitle() 时发出。
    expect(client.getDanmaku).toHaveBeenCalledTimes(1);
    expect((await first.collect()).cues).toEqual(cues);
    expect((await first.collect()).danmaku.items).toEqual(danmaku.items);
  });
});
