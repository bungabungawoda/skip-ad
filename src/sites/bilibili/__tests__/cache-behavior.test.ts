import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import { CACHE_PREFIX, createStorageCache } from "../../../core/ports/cache/store";
import { effectivePromptVersion } from "../analysis/prompt";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import type { PlayerInfo } from "../types";
import type { LlmClient } from "../../../core/ports/llm/client";
import {
  makeClient,
  makeDeps,
  makeLlm,
  makeVideo,
  track,
  cues,
  type DepsOverrides
} from "../../../../tests/helpers/analysis";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";

const NO_ADS = '{"segments":[]}';

/** 共享同一个 storage 区域的依赖组：多次 analyzeVideo 之间可以核对缓存内容。 */
function setup(overrides: DepsOverrides = {}) {
  const area = createMemoryStorageArea();
  const cache = createStorageCache(area, () => 1000);
  // 默认用「无广告」响应：两个分块都完整成功，结果才会进缓存。
  const deps = { ...makeDeps({ llm: makeLlm(NO_ADS), ...overrides }), cache };
  return { area, cache, deps };
}

/**
 * 缓存的外部行为：什么情况写、什么情况复用、键里带哪些段。
 * 这里不测内部实现，只从 analyzeVideo 的调用方视角核对 storage 里的键与 LLM 调用次数。
 */
describe("缓存行为", () => {
  it("缓存键由 bvid、cid、model、生效后的 promptVersion 组成", async () => {
    const { area, deps } = setup();
    await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(area.data.has(`${CACHE_PREFIX}bilibili:BV1test:42:bilibili:4:test-model:v1`)).toBe(true);
  });

  it("用户改写类型描述后缓存键带上 promptVersion 哈希后缀，与改写前的缓存互不命中", async () => {
    const { area, deps } = setup();
    deps.policy = { ...DEFAULT_POLICY, kindPromptOverrides: { sponsor: "口播带货才算商单" } };
    await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    const expected = effectivePromptVersion("v1", { sponsor: "口播带货才算商单" });
    expect(expected).not.toBe("v1");
    expect(area.data.has(`${CACHE_PREFIX}bilibili:BV1test:42:bilibili:4:test-model:${expected}`)).toBe(true);
    expect(area.data.has(`${CACHE_PREFIX}bilibili:BV1test:42:bilibili:4:test-model:v1`)).toBe(false);
  });

  it("LLM 返回不合法 JSON：分块失败不写缓存", async () => {
    const { area, deps } = setup({ llm: makeLlm("not json") });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(result.segments).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === "partial")).toBe(true);
    expect([...area.data.keys()].filter((key) => key.startsWith(CACHE_PREFIX))).toEqual([]);
  });

  it("合法 JSON 但片段未通过校验：保留合法片段，不写缓存", async () => {
    // 280-290 在两个分块范围内都合法；285-280 边界颠倒，两个分块里都被丢弃。
    const llm = makeLlm(
      '{"segments":[' +
        '{"start":280,"end":290,"kind":"sponsor","confidence":0.9,"evidence":["台词"],"reason":"口播"},' +
        '{"start":285,"end":280,"kind":"sponsor","confidence":0.9,"evidence":["台词"],"reason":"颠倒"}' +
      "]}",
    );
    const { area, deps } = setup({ llm });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(result.segments).toEqual([expect.objectContaining({ start: 280, end: 290 })]);
    expect(
      result.warnings.some((warning) => warning.message.includes("未通过校验被丢弃"))
    ).toBe(true);
    expect([...area.data.keys()].filter((key) => key.startsWith(CACHE_PREFIX))).toEqual([]);
  });

  it("连续对话中断：后续内容没读过就不再提问，不写缓存", async () => {
    let calls = 0;
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return NO_ADS;
      }),
    };
    const { area, deps } = setup({ llm });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    // 第 1 轮失败即整体中断：跳着问第 2 轮会拿到断档的时间轴。
    expect(calls).toBe(1);
    expect(result.segments).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.message.includes("1 个分块分析失败"))
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.message.includes("chunk 0 [0-300s]"))
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.message.includes("连续对话在第 1 段中断"))
    ).toBe(true);
    expect([...area.data.keys()].filter((key) => key.startsWith(CACHE_PREFIX))).toEqual([]);
  });

  it("仅弹幕结果在拿不到字幕时直接复用；能读到字幕后重新做全量分析", async () => {
    const area = createMemoryStorageArea();
    const noSubtitlePlayer: PlayerInfo = { isLogin: true, subtitles: [], chapters: [] };
    const withSubtitlePlayer: PlayerInfo = {
      isLogin: true,
      subtitles: [track],
      chapters: [{ start: 0, end: 60, title: "正片" }]
    };

    // 第一次分析：没有字幕轨，得到仅弹幕结果并写缓存。
    const firstLlm = makeLlm(NO_ADS);
    const firstDeps = {
      ...makeDeps({
        llm: firstLlm,
        client: makeClient({ getPlayer: vi.fn(async () => noSubtitlePlayer) })
      }),
      cache: createStorageCache(area, () => 1000)
    };
    const danmakuResult = await analyzeVideo({ bvid: "BV1test", page: 1 }, firstDeps);
    expect(danmakuResult.mode).toBe("danmaku");
    expect([...area.data.keys()].filter((key) => key.startsWith(CACHE_PREFIX))).toHaveLength(1);

    // 第二次分析：仍然没有字幕，直接复用缓存，不调用 LLM。
    const secondLlm = makeLlm(NO_ADS);
    const secondDeps = {
      ...makeDeps({
        llm: secondLlm,
        client: makeClient({ getPlayer: vi.fn(async () => noSubtitlePlayer) })
      }),
      cache: createStorageCache(area, () => 1000)
    };
    const reused = await analyzeVideo({ bvid: "BV1test", page: 1 }, secondDeps);
    expect(reused).toEqual(danmakuResult);
    expect(secondLlm.complete).not.toHaveBeenCalled();

    // 第三次分析：登录后能读到字幕轨，缓存里的仅弹幕结果不再复用，重新做全量。
    const thirdLlm = makeLlm(NO_ADS);
    const thirdDeps = {
      ...makeDeps({
        llm: thirdLlm,
        client: makeClient({ getPlayer: vi.fn(async () => withSubtitlePlayer) })
      }),
      cache: createStorageCache(area, () => 1000)
    };
    const full = await analyzeVideo({ bvid: "BV1test", page: 1 }, thirdDeps);
    expect(full.mode).toBe("full");
    expect(thirdLlm.complete).toHaveBeenCalledTimes(2);
  });

  it("有字幕轨但正文为空：仅弹幕缓存能复用，不重复调用 LLM", async () => {
    const area = createMemoryStorageArea();
    const emptyBodyPlayer: PlayerInfo = {
      isLogin: true,
      subtitles: [track],
      chapters: []
    };
    const client = makeClient({
      getPlayer: vi.fn(async () => emptyBodyPlayer),
      getSubtitle: vi.fn(async () => [])
    });

    const firstLlm = makeLlm(NO_ADS);
    const firstDeps = {
      ...makeDeps({ llm: firstLlm, client }),
      cache: createStorageCache(area, () => 1000)
    };
    const first = await analyzeVideo({ bvid: "BV1test", page: 1 }, firstDeps);
    expect(first.mode).toBe("danmaku");
    expect(first.warnings.some((warning) => warning.code === "subtitle_unavailable")).toBe(true);
    const callsAfterFirst = (firstLlm.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 同一状态再来一次：正文仍为空，仅弹幕结果应当命中缓存，不再调用 LLM。
    const secondLlm = makeLlm(NO_ADS);
    const secondDeps = {
      ...makeDeps({
        llm: secondLlm,
        client: makeClient({
          getPlayer: vi.fn(async () => emptyBodyPlayer),
          getSubtitle: vi.fn(async () => [])
        })
      }),
      cache: createStorageCache(area, () => 1000)
    };
    const second = await analyzeVideo({ bvid: "BV1test", page: 1 }, secondDeps);
    expect(second).toEqual(first);
    expect(secondLlm.complete).not.toHaveBeenCalled();
  });

  it("不同分 P 的缓存键不同：分 P 之间结果不串", async () => {
    const { area, deps } = setup({ llm: makeLlm(NO_ADS) });
    deps.client = makeClient({
      getVideo: vi.fn(async (bvid: string, page: number) => ({
        ...makeVideo(),
        bvid,
        cid: 41 + page
      }))
    });
    const llm = deps.llm as LlmClient;
    await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    await analyzeVideo({ bvid: "BV1test", page: 2 }, deps);
    expect(area.data.has(`${CACHE_PREFIX}bilibili:BV1test:42:bilibili:4:test-model:v1`)).toBe(true);
    expect(area.data.has(`${CACHE_PREFIX}bilibili:BV1test:43:bilibili:4:test-model:v1`)).toBe(true);
    // 每个分 P 各自一个连续对话（2 轮 × 2 次）。
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("5 分钟内字幕变化仍复用缓存", async () => {
    const area = createMemoryStorageArea();
    const cache = createStorageCache(area, () => 1_000);
    const llm = makeLlm(NO_ADS);
    const changedCues = cues.map((cue, index) =>
      index === 0 ? { ...cue, text: `${cue.text}（修订）` } : cue
    );

    const firstDeps = {
      ...makeDeps({
        llm,
        client: makeClient({ getSubtitle: vi.fn(async () => cues) })
      }),
      cache
    };
    const first = await analyzeVideo({ bvid: "BV1test", page: 1 }, firstDeps);

    // 刷新前后字幕被修订的概率很低，5 分钟内按同一份证据处理。
    const secondDeps = {
      ...makeDeps({
        llm,
        client: makeClient({ getSubtitle: vi.fn(async () => changedCues) })
      }),
      cache
    };
    const second = await analyzeVideo({ bvid: "BV1test", page: 1 }, secondDeps);

    expect(second.videoKey).toBe(first.videoKey);
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
