import { describe, expect, it, vi } from "vitest";
import {
  analyzeTranscript,
  chunkTranscriptCues,
  parseTranscriptRound,
  splitTranscriptChunk
} from "../analysis/transcript-analyzer";
import { LlmError, type LlmClient } from "../../../core/ports/llm/client";
import type { LlmMessage } from "../../../core/ports/llm/types";
import type { CacheStore } from "../../../core/ports/cache/store";
import type { SubtitleCue } from "../../../core/plugin/types";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { createStorageCache } from "../../../core/ports/cache/store";

function cuesOf(texts: Array<[number, number, string]>): SubtitleCue[] {
  return texts.map(([start, end, text]) => ({ start, end, text }));
}

/** 调用方算好的缓存键；分析器只使用，不重算。 */
const CACHE_KEY = "youtube:abc:main:youtube:2:test-model:yt-v2";

function makeLlm(responses: string | string[] | ((call: number) => string)): LlmClient & { calls: string[][] } {
  const calls: string[][] = [];
  let count = 0;
  return {
    calls,
    complete: vi.fn(async (messages: LlmMessage[]) => {
      calls.push(messages.map((message) => message.content));
      const index = count;
      count += 1;
      return typeof responses === "function" ? responses(index) : (Array.isArray(responses) ? responses[index] ?? "{}" : responses);
    }),
  };
}

function makeCache(): CacheStore & { entries: Map<string, unknown> } {
  const area = createMemoryStorageArea();
  const store = createStorageCache(area, () => 1_000) as CacheStore & { entries: Map<string, unknown> };
  store.entries = area.data;
  return store;
}

describe("字幕行分块", () => {
  it("行 ID 按发送顺序分配，L000 递增", () => {
    const chunks = chunkTranscriptCues(cuesOf([[0, 5, "a"], [5, 10, "b"], [10, 15, "c"]]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.lines.map((line) => line.id)).toEqual(["L000", "L001", "L002"]);
  });

  it("按字符预算分块，块间不重叠：同一行只属于一块", () => {
    const cues = cuesOf([
      [0, 5, "字".repeat(3_000)],
      [5, 10, "字".repeat(3_000)],
      [10, 15, "字".repeat(3_000)],
      [15, 20, "字".repeat(3_000)]
    ]);
    const chunks = chunkTranscriptCues(cues, { chunkChars: 6_000 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.lines.map((line) => line.id)).toEqual(["L000", "L001"]);
    expect(chunks[1]?.lines.map((line) => line.id)).toEqual(["L002", "L003"]);
    // 连续对话按时间顺序读，任何一行都不允许出现在两轮里。
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.start).toBeGreaterThanOrEqual(chunks[i - 1]?.end ?? 0);
    }
  });

  it("空字幕不产生分块", () => {
    expect(chunkTranscriptCues([])).toEqual([]);
  });

  it("输出耗尽时按行拆成首尾相接的两块，行 ID 不变", () => {
    const chunks = chunkTranscriptCues(
      cuesOf([
        [0, 5, "a".repeat(10)],
        [5, 10, "b".repeat(10)],
        [10, 15, "c".repeat(10)]
      ])
    );
    const split = splitTranscriptChunk(chunks[0] as NonNullable<(typeof chunks)[number]>);
    expect(split).not.toBeNull();
    const [first, second] = split as [NonNullable<(typeof chunks)[number]>, NonNullable<(typeof chunks)[number]>];
    expect(first.lines.map((line) => line.id)).toEqual(["L000", "L001"]);
    expect(first.end).toBe(10);
    expect(second.lines.map((line) => line.id)).toEqual(["L002"]);
    expect(second.start).toBe(10);
  });
});

describe("模型响应校验（行 ID 映射回秒数）", () => {
  const readLines = [
    ["L000", 0, 5, "开场白"],
    ["L001", 5, 15, "本期视频由某品牌赞助"],
    ["L002", 15, 25, "点击链接领取优惠"],
    ["L003", 25, 30, "感谢观看"],
    ["L004", 30, 31, "尾"]
  ].map(([id, start, end, text]) => ({
    id: id as string,
    start: start as number,
    end: end as number,
    text: text as string
  }));

  function parse(text: string, readUpTo = 31): ReturnType<typeof parseTranscriptRound> {
    return parseTranscriptRound(text, readUpTo, readLines);
  }

  it("合法片段：行 ID 映射为秒数，证据行映射为原文，status 显式落盘", () => {
    const parsed = parse(
      '{"segments":[{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001","L002"],"reason":"口播赞助"}]}'
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.segments).toEqual([
      expect.objectContaining({
        start: 5,
        end: 25,
        kind: "sponsor",
        confidence: 0.9,
        status: "closed",
        evidence: ["本期视频由某品牌赞助", "点击链接领取优惠"]
      })
    ]);
  });

  it("拒绝：不存在的行 ID、还没读到的行 ID、颠倒边界、编造证据、短于 3 秒", () => {
    const cases = [
      '{"segments":[{"startId":"L099","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}',
      '{"segments":[{"startId":"L001","endId":"L000","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}',
      '{"segments":[{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L099"]}]}',
      '{"segments":[{"startId":"L004","endId":"L004","kind":"sponsor","confidence":0.9,"evidenceIds":["L004"]}]}'
    ];
    for (const text of cases) {
      const parsed = parse(text);
      expect(parsed.segments).toEqual([]);
      expect(parsed.error).toContain("全部被校验丢弃");
      expect(parsed.dropped).toBeGreaterThan(0);
    }
  });

  it("还没读到的行 ID 不能引用：已读边界只有 20 秒时 L002 起的片段不可用", () => {
    // readUpTo=20 时 L002（end 25）越界；引用它的 closed 片段被钉到边界并标 open。
    const parsed = parse(
      '{"segments":[{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}',
      20
    );
    expect(parsed.segments[0]).toMatchObject({ start: 5, end: 20, status: "open" });
    // 起点越过已读边界 = 猜测，直接丢弃。
    const beyond = parse(
      '{"segments":[{"startId":"L003","endId":"L004","kind":"sponsor","confidence":0.9}]}',
      20
    );
    expect(beyond.segments).toEqual([]);
    expect(beyond.error).toContain("全部被校验丢弃");
    expect(beyond.dropped).toBe(1);
  });

  it("声称 closed 却越过已读边界时降级为 open，终点钉在已读边界", () => {
    const parsed = parse(
      '{"segments":[{"startId":"L001","endId":"L003","status":"closed","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}',
      20
    );
    expect(parsed.segments[0]).toMatchObject({ start: 5, end: 20, status: "open" });
  });

  it("无证据片段置信度压到 0.6；非法 kind 归为 unknown", () => {
    const parsed = parse(
      '{"segments":[{"startId":"L001","endId":"L002","kind":"weird","confidence":0.95,"status":"closed"}]}'
    );
    expect(parsed.segments[0]).toMatchObject({ kind: "unknown", confidence: 0.6 });
  });

  it("精确重复的片段去重", () => {
    const parsed = parse(
      '{"segments":[' +
        '{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"],"status":"closed"},' +
        '{"startId":"L001","endId":"L002","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"],"status":"closed"}' +
      "]}"
    );
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.dropped).toBe(0);
  });

  it("同类型相邻片段合并：间隔 1.5 秒合、1.51 秒不合、跨类型不合", () => {
    const lines = [
      { id: "L000", start: 0, end: 10, text: "a" },
      { id: "L001", start: 11.5, end: 15, text: "b" },
      { id: "L002", start: 16.51, end: 20, text: "c" },
      { id: "L003", start: 20, end: 25, text: "d" }
    ];
    const body = (segments: unknown[]): string => JSON.stringify({ segments });
    const segment = (startId: string, endId: string, kind: string): unknown => ({
      startId,
      endId,
      kind,
      confidence: 0.9,
      evidenceIds: [startId],
      status: "closed"
    });

    // 10 到 11.5 差 1.5 秒：合并成一段。
    const atBoundary = parseTranscriptRound(
      body([segment("L000", "L000", "sponsor"), segment("L001", "L001", "sponsor")]),
      30,
      lines
    );
    expect(atBoundary.segments).toHaveLength(1);
    expect(atBoundary.segments[0]).toMatchObject({ start: 0, end: 15 });

    // 15 到 16.51 差 1.51 秒：保持两段。
    const beyond = parseTranscriptRound(
      body([segment("L001", "L001", "sponsor"), segment("L002", "L002", "sponsor")]),
      30,
      lines
    );
    expect(beyond.segments).toHaveLength(2);

    // 首尾相接但类型不同：不合并，各自保留自己的策略。
    const mixed = parseTranscriptRound(
      body([segment("L002", "L002", "sponsor"), segment("L003", "L003", "promo")]),
      30,
      lines
    );
    expect(mixed.segments).toHaveLength(2);
    expect(mixed.segments.map((item) => item.kind)).toEqual(["sponsor", "promo"]);
  });

  it("起点正好落在已读边界上：本轮跳过，不计入校验丢弃", () => {
    const lines = [
      { id: "L000", start: 0, end: 10, text: "a" },
      { id: "L001", start: 10, end: 20, text: "b" }
    ];
    const body = (segments: unknown[]): string => JSON.stringify({ segments });
    const valid = {
      startId: "L000",
      endId: "L000",
      kind: "sponsor",
      confidence: 0.9,
      evidenceIds: ["L000"],
      status: "closed"
    };
    const boundary = { ...valid, startId: "L001", endId: "L001", evidenceIds: ["L001"] };

    const parsed = parseTranscriptRound(body([valid, boundary]), 10, lines);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.dropped).toBe(0);
    expect(parsed.warning).toBeUndefined();

    // 只有边界那一段时整轮没有可用片段，但这不是坏响应：
    // 下一轮会重新给出，不能因此中断整条对话。
    const onlyBoundary = parseTranscriptRound(body([boundary]), 10, lines);
    expect(onlyBoundary.segments).toEqual([]);
    expect(onlyBoundary.dropped).toBe(0);
    expect(onlyBoundary.error).toBeUndefined();

    // 真正越过边界仍然丢弃并计入。
    const beyond = parseTranscriptRound(body([boundary]), 5, lines);
    expect(beyond.segments).toEqual([]);
    expect(beyond.dropped).toBe(1);
  });

  it("结构里没有 segments 数组时按错误处理，而不是当成无广告", () => {
    const parsed = parse('{"result":"no ads"}');
    expect(parsed.error).toBe("missing segments array");
    expect(parsed.segments).toEqual([]);
  });
});

describe("analyzeTranscript 端到端（连续对话）", () => {
  const cues = cuesOf([
    [0, 5, "大家好"],
    [5, 15, "本期视频由某品牌赞助"],
    [15, 25, "点击链接领取优惠"],
    [25, 35, "回到正题"]
  ]);
  const validResponse =
    '{"segments":[{"startId":"L001","endId":"L002","status":"closed","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}';

  function run(overrides: {
    llm?: LlmClient;
    cues?: SubtitleCue[];
    durationSec?: number;
    prefixCache?: boolean;
    isCancelled?: () => boolean;
    onPartial?: (partial: { segments: unknown[]; done: number; total: number }) => void;
  } = {}) {
    const cache = makeCache();
    const llm = (overrides.llm ?? makeLlm(validResponse)) as LlmClient & {
      calls: string[][];
    };
    const promise = analyzeTranscript(
      {
        video: { site: "youtube", videoId: "abc", partId: "main" },
        cues: overrides.cues ?? cues,
        durationSec: overrides.durationSec ?? 600
      },
      {
        llm,
        cache,
        cacheKey: CACHE_KEY,
        buildSystemPrompt: () => ({ role: "system", content: "system prompt" }),
        buildRoundPrompt: (context) => ({
          role: "user",
          content: `chunk ${context.round.index} readUpTo ${context.round.readUpTo}`
        }),
        prefixCache: overrides.prefixCache,
        now: () => 1_000,
        signal: new AbortController().signal,
        isCancelled: overrides.isCancelled,
        onProgress: () => undefined,
        onPartial: overrides.onPartial
      }
    );
    return { promise, cache, llm };
  }

  it("单块视频：增量发布与缓存写入，全部分块成功且字幕完整才写缓存", async () => {
    const onPartial = vi.fn();
    const { promise, cache, llm } = run({ onPartial });
    const result = await promise;
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith({
      segments: [expect.objectContaining({ start: 5, end: 25, kind: "sponsor" })],
      done: 1,
      total: 1,
      // 增量结果必须带时长与证据形态：mergePartial 的覆盖率守卫盯着它们。
      durationSec: 600,
      mode: "full"
    });
    expect(result.warnings).toEqual([]);
    expect(result.mode).toBe("full");
    // 结果与缓存使用同一个键：键由调用方算好，分析器不再重算。
    expect(result.videoKey).toBe(CACHE_KEY);
    expect(cache.entries.has(`skipad-cache:${CACHE_KEY}`)).toBe(true);
  });

  it("连续对话：system 只发一次，每轮把「证据 / 整表」问答追加进历史，最后一轮定稿 open", async () => {
    // 第 1 轮只读到 L001（15 秒处），广告没结尾只能标 open、end 钉在已读边界；
    // 第 2 轮读到 L002 后把同一片段修订成 closed，结尾落到真实行尾 25 秒。
    const openThenClosed = (call: number): string =>
      call === 0
        ? '{"segments":[{"startId":"L001","endId":"L001","status":"open","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}'
        : '{"segments":[{"startId":"L001","endId":"L002","status":"closed","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}';
    // 两条 3000 字符的台词恰好装满 6000 预算：切出两块，形成两轮对话。
    const longCues = cuesOf([
      [0, 5, "开场".padEnd(3_000, "字")],
      [5, 15, "本期视频由某品牌赞助".padEnd(3_000, "字")],
      [15, 25, "点击链接领取优惠"],
      [25, 35, "回到正题"]
    ]);
    const { promise, llm } = run({ llm: makeLlm(openThenClosed), cues: longCues });
    const result = await promise;
    expect(llm.complete).toHaveBeenCalledTimes(2);
    const first = llm.calls[0] ?? [];
    const second = llm.calls[1] ?? [];
    expect(first).toHaveLength(2); // system + 第 1 轮证据
    expect(second).toHaveLength(4); // system + 第 1 轮证据 + assistant 表 + 第 2 轮证据
    // 第 1 轮的 open 表写回历史（assistant 消息），模型从这里知道该改哪一条。
    expect(second[2]).toContain('"status":"open"');
    expect(second[2]).toContain('"start":5');
    // 第 2 轮读到 35 秒；第 2 轮的行块只含本块台词。
    expect(second[3]).toContain("chunk 1 readUpTo 35");
    expect(result.segments[0]).toMatchObject({
      start: 5,
      end: 25,
      kind: "sponsor",
      status: "closed"
    });
  });

  it("某块输出耗尽时拆成两个子块继续，最终结果完整", async () => {
    const llm = makeLlm((call) => {
      if (call === 0) throw new LlmError("推理耗尽输出额度", "truncated");
      return '{"segments":[]}';
    });
    const longCues = cuesOf([
      [0, 5, "开场".padEnd(3_000, "字")],
      [5, 15, "本期视频由某品牌赞助".padEnd(3_000, "字")],
      [15, 25, "点击链接领取优惠"],
      [25, 35, "回到正题"]
    ]);
    const { promise, cache, llm: tracked } = run({ llm, cues: longCues });
    const result = await promise;

    expect(tracked.complete).toHaveBeenCalledTimes(4);
    expect(tracked.calls[1]?.at(-1)).toContain("chunk 0 readUpTo 5");
    expect(tracked.calls[2]?.at(-1)).toContain("chunk 1 readUpTo 15");
    expect(tracked.calls[3]?.at(-1)).toContain("chunk 2 readUpTo 35");
    expect(result.warnings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(cache.entries.has(`skipad-cache:${CACHE_KEY}`)).toBe(true);
  });

  it("分块失败：中断对话，保留已完成整表，不写缓存，警告 partial", async () => {
    const llm = makeLlm((call) => {
      if (call === 1) throw new Error("network down");
      // 第 1 轮只读到 L001，广告没结尾标 open。
      return '{"segments":[{"startId":"L001","endId":"L001","status":"open","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}';
    });
    const longCues = cuesOf([
      [0, 5, "开场".padEnd(3_000, "字")],
      [5, 15, "本期视频由某品牌赞助".padEnd(3_000, "字")],
      [15, 25, "点击链接领取优惠"],
      [25, 35, "回到正题"]
    ]);
    const { promise, cache } = run({ llm, cues: longCues });
    const result = await promise;
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result.segments).toEqual([
      expect.objectContaining({ start: 5, end: 15, status: "open" })
    ]);
    expect(
      result.warnings.some((warning) => warning.message.includes("连续对话在第 2 段中断"))
    ).toBe(true);
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("取消：已完成分块保留但不写缓存", async () => {
    let cancelledAfterFirst = false;
    const llm = makeLlm((call) => {
      // 第一个分块的响应返回后触发取消，第二个分块前停止。
      if (call === 0) cancelledAfterFirst = true;
      // 第 1 轮只读到 L001，引用未读行会被校验拒绝，这里只引用已读行。
      return '{"segments":[{"startId":"L001","endId":"L001","status":"open","kind":"sponsor","confidence":0.9,"evidenceIds":["L001"]}]}';
    });
    const { promise, cache } = run({
      llm,
      cues: cuesOf([
        [0, 5, "a".repeat(3_000)],
        [5, 10, "b".repeat(3_000)],
        [10, 15, "c".repeat(3_000)]
      ]),
      isCancelled: () => cancelledAfterFirst
    });
    const result = await promise;
    expect(result.warnings.some((warning) => warning.message.includes("分析已取消"))).toBe(true);
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("单块响应返回后才取消：同样不写缓存", async () => {
    // 循环只在每块开始前查取消；单块视频在响应返回后取消时，必须再查一次。
    let cancelled = false;
    const llm = makeLlm(() => {
      cancelled = true;
      return validResponse;
    });
    const { promise, cache } = run({ llm, isCancelled: () => cancelled });
    await promise;
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("无字幕：不产生分块也不写缓存", async () => {    const { promise, cache, llm } = run({ cues: [] });
    const result = await promise;
    expect(result.segments).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("片段被校验丢弃时不算完整成功，也不写缓存", async () => {
    const dropping = '{"segments":[{"startId":"L099","endId":"L002","kind":"sponsor","confidence":0.9}]}';
    const { promise, cache } = run({ llm: makeLlm(dropping) });
    const result = await promise;
    expect(result.segments).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === "partial")).toBe(true);
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("时长为 0 时不写缓存，即使模型返回空结果", async () => {
    const { promise, cache } = run({
      llm: makeLlm('{"segments":[]}'),
      durationSec: 0
    });
    await promise;
    expect([...cache.entries.keys()]).toEqual([]);
  });

  it("服务商有自动前缀缓存时保留完整历史，不改写旧轮消息", async () => {
    const { promise, llm } = run({
      llm: makeLlm('{"segments":[]}'),
      cues: fourRoundCues(),
      prefixCache: true
    });
    await promise;
    expect(llm.complete).toHaveBeenCalledTimes(4);
    const fourth = llm.calls[3] ?? [];
    // 没有摘要行：前三轮的证据原样留在第 4 轮请求里，与上一轮逐 token 同前缀。
    expect(fourth).toHaveLength(8); // system + 3 组完整问答 + 第 4 轮 user
    expect(fourth[1]).toContain("chunk 0");
    expect(fourth[3]).toContain("chunk 1");
    expect(fourth[5]).toContain("chunk 2");
    expect(fourth[7]).toContain("chunk 3");
  });

  it("没有前缀缓存的服务商压缩历史：更早的轮次只留摘要行", async () => {
    const { promise, llm } = run({
      llm: makeLlm('{"segments":[]}'),
      cues: fourRoundCues()
    });
    await promise;
    const fourth = llm.calls[3] ?? [];
    expect(fourth[1]).toContain("已读完");
    expect(fourth[3]).toContain("chunk 1");
    expect(fourth[5]).toContain("chunk 2");
    expect(fourth[7]).toContain("chunk 3");
  });
});

/** 4 块台词：原始几条 + 14 段 1500 字符填充，6000 预算每 4 段一组，凑满 4 轮。 */
function fourRoundCues(): SubtitleCue[] {
  return [
    ...cuesOf([
      [0, 5, "开场"],
      [5, 15, "本期视频由某品牌赞助"],
      [15, 25, "点击链接领取优惠"],
      [25, 35, "回到正题"]
    ]),
    ...Array.from({ length: 14 }, (_, index) => ({
      start: 40 + index * 10,
      end: 48 + index * 10,
      text: "字".repeat(1_500)
    }))
  ];
}
