import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import type { LlmClient } from "../../../core/ports/llm/client";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import type { PlayerInfo } from "../types";
import { cues300, makeClient, makeDeps, makeLlm, makeVideo, track } from "../../../../tests/helpers/analysis";

describe("analyzeVideo", () => {
  it("runs the full pipeline with a fake client and fake LLM", async () => {
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps());
    expect(result.mode).toBe("full");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 120, kind: "sponsor" });
    expect(result.videoKey).toContain("bilibili:BV1test:42:bilibili:4:test-model:v1");
  });

  it("uses the cache on the second call and does not refetch the player", async () => {
    const fakeClient = makeClient();
    // 每个分块都返回空结果：这是完整成功的「无广告」分析，可以进缓存。
    const llm = makeLlm('{"segments":[]}');
    const sharedDeps = makeDeps({ client: fakeClient, llm });
    const first = await analyzeVideo({ bvid: "BV1test", page: 1 }, sharedDeps);
    const second = await analyzeVideo({ bvid: "BV1test", page: 1 }, sharedDeps);
    expect(second).toEqual(first);
    // 缓存命中直接返回，不再请求播放器。
    expect(fakeClient.getPlayer).toHaveBeenCalledTimes(1);
    // 600 秒视频按 300 秒首尾相接切成 2 段，一个连续对话共 2 轮。
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("falls back to danmaku mode when there is no subtitle track", async () => {
    const fakeClient = makeClient({
      getPlayer: vi.fn(async (): Promise<PlayerInfo> => ({
        isLogin: true,
        subtitles: [],
        chapters: []
      }))
    });
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ client: fakeClient })
    );
    expect(result.mode).toBe("danmaku");
    expect(result.warnings.some((warning) => warning.code === "subtitle_missing")).toBe(true);
    expect(result.segments[0]?.families).toEqual(
      expect.arrayContaining(["jump_coordinate", "ad_word"])
    );
  });

  it("reports partial warnings for both failure paths with their reasons", async () => {
    const failing: LlmClient = {
      complete: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const failures = [
      { input: makeDeps({ llm: failing }), reason: "network down" },
      { input: makeDeps({ llm: makeLlm("not json") }), reason: "no json object found" }
    ];
    for (const { input, reason } of failures) {
      const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, input);
      expect(result.segments).toEqual([]);
      const partial = result.warnings.find((warning) => warning.code === "partial");
      expect(partial?.message).toContain(reason);
    }
  });

  it("连续对话整表里精确重复的片段会被去重", async () => {
    const repeated = `{"segments":[
      {"start":100,"end":120,"status":"closed","kind":"sponsor","confidence":0.9,"evidence":["a"],"reason":""},
      {"start":100,"end":120,"status":"closed","kind":"sponsor","confidence":0.9,"evidence":["a"],"reason":""}
    ]}`;
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ llm: makeLlm(repeated) })
    );
    expect(result.segments).toHaveLength(1);
  });
});

describe("analyzeVideo 的时长与取消", () => {
  it("接口时长为 0 时用字幕结尾兜底，片段不被归一化丢弃", async () => {
    const client = makeClient({
      getVideo: vi.fn(async () => ({
        ...makeVideo(),
        duration: 0,
        pages: [{ cid: 42, page: 1, part: "P1", duration: 0 }]
      }))
    });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ client }));
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it("按分块增量下发已合并的片段", async () => {
    const onPartial = vi.fn();
    const client = makeClient({
      getVideo: vi.fn(async () => ({ ...makeVideo(), duration: 300 })),
      // 300 秒视频要配覆盖到结尾的字幕，否则会按「字幕不完整」降级。
      getSubtitle: vi.fn(async () => cues300)
    });
    const deps = { ...makeDeps({ client }), onPartial };
    await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial.mock.calls[0]?.[0]).toMatchObject({
      segments: [expect.objectContaining({ start: 100, end: 120 })],
      done: 1,
      total: 1
    });
  });

  it("视频、播放器、弹幕、字幕请求都收到同一个取消信号", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const client = makeClient({
      getVideo: vi.fn(async (_bvid, _page, signal?: AbortSignal) => {
        signals.push(signal);
        return { ...makeVideo(), duration: 300 };
      }),
      getPlayer: vi.fn(async (_aid: number, _cid: number, signal?: AbortSignal) => {
        signals.push(signal);
        return { isLogin: true, subtitles: [track], chapters: [] };
      }),
      getDanmaku: vi.fn(async (_cid, signal?: AbortSignal) => {
        signals.push(signal);
        return { items: [] };
      }),
      getSubtitle: vi.fn(async (_track, signal?: AbortSignal) => {
        signals.push(signal);
        return cues300;
      })
    });
    const deps = { ...makeDeps({ client }), signal: controller.signal };
    await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("分析结果带上本次使用的分 P 时长", async () => {
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps());
    expect(result.durationSec).toBe(600);
  });
});

describe("analyzeVideo 的进度、取消与提示词改写", () => {
  it("每完成一个分块回调一次进度，总数恒定", async () => {
    const onProgress = vi.fn();
    await analyzeVideo({ bvid: "BV1test", page: 1 }, { ...makeDeps(), onProgress });
    const total = onProgress.mock.calls.at(-1)?.[1];
    expect(total).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenCalledWith(total, total);
    expect(new Set(onProgress.mock.calls.map((call) => call[1])).size).toBe(1);
  });

  it("取消后不再请求后续分块，且不写缓存", async () => {
    const isCancelled = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const deps = makeDeps({ isCancelled });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(isCancelled).toHaveBeenCalled();
    expect(result.warnings.some((warning) => warning.code === "partial")).toBe(true);
    await expect(deps.cache.get(result.videoKey)).resolves.toBeNull();
  });

  it("用户改写类型描述进入系统提示词并折进缓存键", async () => {
    const policy = {
      ...DEFAULT_POLICY,
      kindPromptOverrides: { sponsor: "用户自定义的商单定义" }
    };
    const deps = makeDeps({ policy });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    const firstCall = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const systemPrompt = firstCall?.[0]?.content as string | undefined;
    expect(systemPrompt).toContain("用户对类型的定义");
    expect(systemPrompt).toContain("用户自定义的商单定义");
    expect(result.videoKey).toMatch(/^bilibili:BV1test:42:bilibili:4:test-model:v1:[0-9a-f]{8}$/);
  });
});

describe("字幕归属与覆盖率", () => {
  /** 线上形态的 aid/cid：拼起来 26 位数字，才认得出字幕文件名的归属前缀。 */
  const REAL_AID = 117_557_566_641_975;
  const REAL_CID = 43_321_789_454;
  /** 77 秒的视频，字幕说到 60.2 秒就结束：结尾是音乐和空镜，覆盖率 0.78。 */
  const shortVideoCues = [
    { start: 0.1, end: 3.8, text: "到了" },
    { start: 56.2, end: 60.2, text: "我都感觉你没听够呢啊" }
  ];

  function depsWith(trackUrl: string) {
    const client = makeClient({
      getVideo: vi.fn(async () => ({
        ...makeVideo(),
        aid: REAL_AID,
        cid: REAL_CID,
        duration: 77,
        pages: [{ cid: REAL_CID, page: 1, part: "P1", duration: 77 }]
      })),
      getPlayer: vi.fn(async (): Promise<PlayerInfo> => ({
        isLogin: true,
        subtitles: [{ lan: "ai-zh", url: trackUrl }],
        chapters: []
      })),
      getSubtitle: vi.fn(async () => shortVideoCues)
    });
    return makeDeps({ client });
  }

  it("文件名前缀证明是本视频的字幕时，尾部没有台词也不降级", async () => {
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      depsWith(`https://aisubtitle.example/bfs/ai_subtitle/prod/${REAL_AID}${REAL_CID}92d74176c0.json`)
    );
    expect(result.mode).toBe("full");
    expect(result.warnings.some((warning) => warning.code === "subtitle_incomplete")).toBe(false);
  });

  it("读不出归属的字幕也照用，提示词写清台词到哪结束", async () => {
    const deps = depsWith("https://i0.hdslb.com/bfs/subtitle/5f2c1e9a.json");
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(result.mode).toBe("full");
    const firstCall = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = firstCall?.[1]?.content as string;
    // 字幕只到 60.2 秒，全片 77 秒：两个数都要告诉模型。
    expect(userMessage).toContain("全片台词只到");
    expect(userMessage).toContain("视频总时长：01:17");
    expect(userMessage).toContain("之后没有台词");
  });
});
