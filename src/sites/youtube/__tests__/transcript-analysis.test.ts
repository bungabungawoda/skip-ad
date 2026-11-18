// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { createYouTubeSegmentAnalyzer } from "../analysis/analyzer";
import { requestPlayerData, type PlayerDataResult } from "../player-bridge";
import { sanitizeBridgeTracks, type BridgeTrack } from "../player-bridge-protocol";
import type { AnalysisServices } from "../../../core/plugin/types";
import type { AnalysisPolicy } from "../../../core/analysis/types";
import type { LlmMessage } from "../../../core/ports/llm/types";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { LlmError, type LlmClient } from "../../../core/ports/llm/client";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { CACHE_PREFIX, createStorageCache, type CacheStore } from "../../../core/ports/cache/store";

/**
 * YouTube 字幕分析端到端（LLM 全部 mock）：
 * 正常赞助段、多个赞助段、自我推广、整期产品主题、无字幕、空字幕、
 * 跨分块广告、5 分钟内复用缓存、缓存命中不重复分析。
 */

vi.mock("../player-bridge", () => ({
  requestPlayerData: vi.fn()
}));

// 分析器只走字幕读取；面板单独测（panel-client.test），这里固定成「面板没字幕」。
vi.mock("../panel-client", () => ({
  requestPanelCues: vi.fn(async () => ({
    status: "failed",
    detail: "面板里没有可用的字幕段"
  }))
}));

const bridgeMock = vi.mocked(requestPlayerData);
let bridgeTracks: BridgeTrack[] = [];
let bridgeLength = 600;

const SPONSOR_RESPONSE =
  '{"segments":[{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.92,"evidenceIds":["L001","L002"],"reason":"口播赞助"}]}';

function json3(cues: Array<[number, number, string]>) {
  return {
    events: cues.map(([start, duration, text]) => ({
      tStartMs: start * 1_000,
      dDurationMs: duration * 1_000,
      segs: [{ utf8: text }]
    }))
  };
}

// json3 的第二个字段是时长（秒），不是结束时间。
const SPONSOR_JSON3 = json3([
  [0, 5, "大家好欢迎观看"],
  [5, 5, "本期视频由某品牌赞助"],
  [10, 5, "点击简介链接领取优惠"],
  [15, 5, "回到正题"]
]);

function mountPage(options: { tracks?: unknown; lengthSeconds?: number } = {}) {
  const captions =
    options.tracks === undefined
      ? {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en",
                languageCode: "en",
                kind: "asr",
                name: { simpleText: "English (auto)" }
              }
            ]
          }
        }
      : options.tracks;
  const rawTracks = (
    captions as
      | { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } }
      | null
      | undefined
  )?.playerCaptionsTracklistRenderer?.captionTracks;
  bridgeTracks = sanitizeBridgeTracks(rawTracks);
  bridgeLength = options.lengthSeconds ?? 600;
  (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
    videoDetails: {
      videoId: "abc",
      title: "测试视频",
      author: "频道",
      lengthSeconds: bridgeLength
    },
    captions
  };
}

beforeEach(() => {
  bridgeTracks = [];
  bridgeLength = 600;
  bridgeMock.mockReset();
  bridgeMock.mockImplementation(async (videoId): Promise<PlayerDataResult> => ({
    status: "ok",
    videoId,
    source: "app",
    lengthSeconds: bridgeLength,
    tracks: bridgeTracks
  }));
});

afterEach(() => {
  delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  vi.unstubAllGlobals();
});

interface SetupOverrides {
  llm?: LlmClient;
  policy?: AnalysisPolicy;
  fetchBody?: unknown;
  cache?: CacheStore;
}

type CacheWithEntries = ReturnType<typeof createStorageCache> & { entries: Map<string, unknown> };

/** 缓存条目数：storage 里还存着「缓存索引」键，它不是缓存条目。 */
function cacheEntries(entries: Map<string, unknown>): string[] {
  return [...entries.keys()].filter((key) => key.startsWith(CACHE_PREFIX));
}

function setup(overrides: SetupOverrides = {}) {
  const area = createMemoryStorageArea();
  const store = (overrides.cache ??
    (() => {
      const created = createStorageCache(area, () => 1_000) as unknown as CacheWithEntries;
      created.entries = area.data;
      return created;
    })()) as CacheWithEntries;
  const cache = store;
  const llm = overrides.llm as LlmClient;
  const services: AnalysisServices = {
    llm,
    cache,
    readSettings: async () => ({
      policy: overrides.policy ?? DEFAULT_POLICY,
      llmConfigured: true,
      decisionConfigured: false,
      analysisConfigured: true,
      model: "test-model",
      siteSwitches: {}
    })
  };
  const analyzer = createYouTubeSegmentAnalyzer(services);
  return {
    analyzer,
    cache,
    llm,
    run: (videoId = "abc") =>
      analyzer.analyze({
        video: { site: "youtube", videoId, partId: "main" },
        currentTime: 0,
        signal: new AbortController().signal
      })
  };
}

function makeLlm(content: string | ((call: number) => string)): LlmClient {
  let count = 0;
  return {
    complete: vi.fn(async () => {
      const index = count;
      count += 1;
      return typeof content === "function" ? content(index) : content;
    }),
  };
}

function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(payload) }))
  );
}

describe("YouTube 字幕分析（mock LLM）", () => {
  it("正常赞助段：行 ID 映射为时间轴片段，结果进缓存", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const { run, cache } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    expect(result.segments).toEqual([
      expect.objectContaining({ start: 5, end: 15, kind: "sponsor", confidence: 0.92 })
    ]);
    expect(result.mode).toBe("full");
    expect(result.video).toEqual({ site: "youtube", videoId: "abc", partId: "main" });
    expect(cacheEntries(cache.entries)).toHaveLength(1);
  });

  it("多个赞助段：两个片段都保留", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const multi =
      '{"segments":[' +
      '{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]},' +
      '{"startId":"L002","endId":"L003","kind":"promo","confidence":0.85,"evidenceIds":["L002"]}' +
      "]}";
    const { run } = setup({ llm: makeLlm(multi) });
    const result = await run();
    expect(result.segments.map((segment) => segment.kind)).toEqual(["sponsor", "promo"]);
  });

  it("自我推广与整期产品主题：类型原样返回，交由策略层判定", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const response =
      '{"segments":[{"startId":"L001","endId":"L002","kind":"self_promo","confidence":0.88,"evidenceIds":["L001"]}]}';
    const { run } = setup({ llm: makeLlm(response) });
    const result = await run();
    expect(result.segments[0]?.kind).toBe("self_promo");

    const topic =
      '{"segments":[{"startId":"L000","endId":"L003","kind":"topic","confidence":0.9,"evidenceIds":["L000"]}]}';
    const second = setup({ llm: makeLlm(topic) });
    const topicResult = await second.run();
    expect(topicResult.segments[0]?.kind).toBe("topic");
  });

  it("认证失败：返回 llm_failed，不重发也不写缓存", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        throw new LlmError("HTTP 401: invalid key", "auth", 401);
      })
    };
    const { run, cache } = setup({ llm });
    const result = await run();
    expect(result.warnings.map((warning) => warning.code)).toContain("llm_failed");
    expect(result.segments).toHaveLength(0);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("无字幕：返回 subtitle_missing 与 no_context，不写缓存，也不调用 LLM", async () => {
    mountPage({ tracks: {} });
    const { run, cache, llm } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    expect(result.segments).toEqual([]);
    expect(result.warnings[0]?.code).toBe("subtitle_missing");
    // YouTube 没有弹幕可退，没有字幕就是没有可读上下文。
    expect(result.warnings.map((warning) => warning.code)).toContain("no_context");
    expect(llm.complete).not.toHaveBeenCalled();
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("播放器数据没读到：返回 player_data_unavailable，不调用 LLM，不写阴性缓存", async () => {
    mountPage();
    const response = (
      window as {
        ytInitialPlayerResponse?: { videoDetails?: { videoId?: string } };
      }
    ).ytInitialPlayerResponse;
    if (response?.videoDetails) response.videoDetails.videoId = "stale";
    bridgeMock.mockResolvedValueOnce({ status: "unavailable", detail: "桥没有响应" });

    const { run, cache, llm } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run("abc");
    expect(result.segments).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "player_data_unavailable"
    ]);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("空字幕：字幕轨没有正文，返回 transcript_fetch_failed，不写阴性缓存", async () => {
    mountPage();
    stubFetch({ events: [] });
    const { run, cache } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    expect(result.segments).toEqual([]);
    // 轨道存在但正文为空，是「没读到」，不是「没有字幕」；不能带 no_context。
    expect(result.warnings.map((warning) => warning.code)).toEqual(["transcript_fetch_failed"]);
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("字幕读取失败：fetch 报错降级为 transcript_fetch_failed", async () => {
    mountPage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("blocked");
      })
    );
    const { run, cache } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    expect(result.warnings[0]?.code).toBe("transcript_fetch_failed");
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("跨分块广告：第 1 轮标 open，第 2 轮修订到真实结尾，最终只有一条", async () => {
    const longCues = json3([
      [0, 5, "字".repeat(3_000)],
      [5, 10, "本期视频由某品牌赞助".padEnd(3_000, "字")],
      [10, 15, "点击简介链接领取优惠".padEnd(3_000, "字")],
      [15, 20, "回到正题".padEnd(3_000, "字")]
    ]);
    mountPage();
    stubFetch(longCues);
    // 两条 3000 字符台词装满第一块：第 1 轮读到 15 秒（L000/L001），
    // 广告没结尾标 open；第 2 轮读到 L002 后修订成 closed，结尾 25 秒。
    const perRound = (call: number) =>
      call === 0
        ? '{"segments":[{"startId":"L001","endId":"L001","status":"open","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}'
        : '{"segments":[{"startId":"L001","endId":"L002","status":"closed","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}';
    const { run, llm } = setup({ llm: makeLlm(perRound) });
    const result = await run();
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      kind: "sponsor",
      start: 5,
      end: 25,
      status: "closed"
    });
  });

  it("缓存命中：同一字幕与轨道重复分析不再次调用 LLM", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const llm = makeLlm(SPONSOR_RESPONSE);
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const first = setup({ llm, cache });
    await first.run();
    const second = setup({ llm, cache });
    const cached = await second.run();
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(cached.segments).toHaveLength(1);
  });

  it("缓存命中不再读取字幕", async () => {
    mountPage();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(SPONSOR_JSON3)
    }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = makeLlm(SPONSOR_RESPONSE);
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const first = setup({ llm, cache });
    await first.run();
    const second = setup({ llm, cache });
    await second.run();
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5 分钟内字幕变化仍命中缓存，不重复分析", async () => {
    mountPage();
    let payload: unknown = SPONSOR_JSON3;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify(payload)
    }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = makeLlm(SPONSOR_RESPONSE);
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const first = setup({ llm, cache });
    await first.run();

    // 刷新前后字幕被修订的概率很低，5 分钟内按同一份证据处理。
    payload = json3([
      [0, 5, "大家好欢迎观看"],
      [5, 5, "本期视频由另一家品牌赞助"],
      [10, 5, "点击简介链接领取优惠"],
      [15, 5, "回到正题"]
    ]);
    const second = setup({ llm, cache });
    const reused = await second.run();

    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(reused.segments).toHaveLength(1);
  });

  it("页面没有可信时长时只标记，不把字幕结尾写进缓存", async () => {
    mountPage({ lengthSeconds: 0 });
    stubFetch(SPONSOR_JSON3);
    const { run, cache } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    expect(result.durationSec).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("页面 video-id 缺失时，不用播放器时长冒充正片时长", async () => {
    mountPage({ lengthSeconds: 0 });
    stubFetch(SPONSOR_JSON3);
    const video = document.createElement("video");
    Object.defineProperty(video, "duration", { configurable: true, value: 30 });
    document.body.append(video);
    const { run, cache } = setup({ llm: makeLlm(SPONSOR_RESPONSE) });
    const result = await run();
    video.remove();
    expect(result.durationSec).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(cacheEntries(cache.entries)).toHaveLength(0);
  });

  it("用户改写的类型描述进入 YouTube 提示词", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const calls: LlmMessage[][] = [];
    const llm: LlmClient = {
      complete: vi.fn(async (messages: LlmMessage[]) => {
        calls.push(messages);
        return SPONSOR_RESPONSE;
      }),
    };
    const policy: AnalysisPolicy = {
      ...DEFAULT_POLICY,
      kindPromptOverrides: { sponsor: "自定义商单定义" }
    };
    const { run } = setup({ llm, policy });
    await run();
    expect(calls[0]?.[0]?.content).toContain("自定义商单定义");
  });

  it("改写类型描述后缓存键仍能命中，不重复调用 LLM", async () => {
    mountPage();
    stubFetch(SPONSOR_JSON3);
    const policy: AnalysisPolicy = {
      ...DEFAULT_POLICY,
      kindPromptOverrides: { sponsor: "自定义商单定义" }
    };
    const llm = makeLlm(SPONSOR_RESPONSE);
    const cache = createStorageCache(createMemoryStorageArea(), () => 1_000);
    const first = setup({ llm, cache, policy });
    await first.run();
    const second = setup({ llm, cache, policy });
    await second.run();
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
