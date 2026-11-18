import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage, handleRequest, type HandlerContext } from "../handlers";
import { createMemoryStorageArea } from "../../../tests/helpers/memory-storage";
import { createStorageCache } from "../../core/ports/cache/store";
import { createLlmAbortRegistry } from "../../core/ports/llm-abort";
import { createMetricsStore } from "../../core/metrics/store";
import type { AnalysisResult } from "../../core/analysis/types";
import { readLlmConfig, saveConnection } from "../../core/ports/settings";
import { readDecisionConfig, writeDecisionConfig } from "../../core/ports/decision/config";

function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const area = createMemoryStorageArea();
  return {
    area,
    cache: createStorageCache(area, () => 1_000),
    aborts: createLlmAbortRegistry(),
    metrics: createMetricsStore(area),
    senderTabId: undefined,
    ...overrides
  };
}

function resultOf(): AnalysisResult {
  return {
    videoKey: "bilibili:BV1:42:bilibili:1:m:v1",
    video: { site: "bilibili", videoId: "BV1", partId: "42" },
    mode: "full",
    segments: [],
    warnings: [],
    durationSec: 100
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("后台请求分派", () => {
  it("settings.get 返回默认策略与未配置状态", async () => {
    const response = await handleRequest({ type: "settings.get" }, context());
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value).toMatchObject({
      llmConfigured: false,
      decisionConfigured: false,
      analysisConfigured: false,
      siteSwitches: {}
    });
  });

  it("settings.setPolicy 会规范化并落盘", async () => {
    const ctx = context();
    const response = await handleRequest(
      { type: "settings.setPolicy", patch: { perKind: { topic: "auto" } } },
      ctx
    );
    expect(response.ok).toBe(true);
    const stored = await handleRequest({ type: "settings.get" }, ctx);
    if (!stored.ok) throw new Error("settings.get failed");
    expect((stored.value as { policy: { perKind: { topic: string } } }).policy.perKind.topic).toBe(
      "off"
    );
  });

  it("类型策略保存只改补丁字段，保留另一个设置页刚写的值", async () => {
    const ctx = context();
    await handleRequest(
      { type: "settings.setPolicy", patch: { kindPromptOverrides: { sponsor: "口播带货" } } },
      ctx
    );
    await handleRequest(
      { type: "settings.setPolicy", patch: { perKind: { sponsor: "mark" } } },
      ctx
    );
    const stored = await handleRequest({ type: "settings.get" }, ctx);
    if (!stored.ok) throw new Error("settings.get failed");
    const policy = (stored.value as { policy: Record<string, unknown> }).policy;
    expect(policy).toMatchObject({
      perKind: expect.objectContaining({ sponsor: "mark" }),
      kindPromptOverrides: { sponsor: "口播带货" }
    });
  });

  it("settings.setSiteSwitches 接收未知形状并规范化", async () => {
    const ctx = context();
    await handleRequest(
      {
        type: "settings.setSiteSwitches",
        patch: { youtube: { enabled: false, platformAdSkip: true, segmentAnalysis: true } }
      },
      ctx
    );
    const stored = await handleRequest({ type: "settings.get" }, ctx);
    if (!stored.ok) throw new Error("settings.get failed");
    const switches = (stored.value as { siteSwitches: Record<string, unknown> }).siteSwitches;
    expect(switches.youtube).toMatchObject({ enabled: false, segmentAnalysis: true });
  });

  it("按站点保存开关时保留其它站点已存的值", async () => {
    const ctx = context();
    await handleRequest(
      {
        type: "settings.setSiteSwitches",
        patch: { bilibili: { enabled: false, platformAdSkip: true, segmentAnalysis: true } }
      },
      ctx
    );
    await handleRequest(
      {
        type: "settings.setSiteSwitches",
        patch: { youtube: { enabled: false, platformAdSkip: false, segmentAnalysis: true } }
      },
      ctx
    );
    const stored = await handleRequest({ type: "settings.get" }, ctx);
    if (!stored.ok) throw new Error("settings.get failed");
    const switches = (stored.value as { siteSwitches: Record<string, unknown> }).siteSwitches;
    expect(switches.bilibili).toMatchObject({ enabled: false, platformAdSkip: true });
    expect(switches.youtube).toMatchObject({ enabled: false, platformAdSkip: false });
  });

  it("cache 的写读删清走同一条链路", async () => {
    const ctx = context();
    const entry = { result: resultOf(), createdAt: 1_000 };
    await handleRequest({ type: "cache.set", key: "k", entry }, ctx);
    const got = await handleRequest({ type: "cache.get", key: "k" }, ctx);
    expect(got.ok && got.value).toMatchObject({ createdAt: 1_000 });
    await handleRequest({ type: "cache.delete", key: "k" }, ctx);
    const afterDelete = await handleRequest({ type: "cache.get", key: "k" }, ctx);
    expect(afterDelete.ok && afterDelete.value).toBeNull();
    await handleRequest({ type: "cache.clear" }, ctx);
  });

  it("ignore.add 去重并保留最近 200 条，ignore.get 读回", async () => {
    const ctx = context();
    await handleRequest({ type: "ignore.add", videoKey: "v", segmentKey: "1.00-2.00" }, ctx);
    await handleRequest({ type: "ignore.add", videoKey: "v", segmentKey: "1.00-2.00" }, ctx);
    const response = await handleRequest({ type: "ignore.get", videoKey: "v" }, ctx);
    expect(response.ok && response.value).toEqual(["1.00-2.00"]);
  });

  it("设置写完后通知所有标签页重读", async () => {
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi
          .fn()
          .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, {}])
          .mockResolvedValueOnce([]),
        sendMessage
      },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });
    const ctx = context();
    const response = await handleRequest({ type: "settings.setPolicy", patch: {} }, ctx);
    expect(response.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(1, { type: "settings.changed" });
    expect(sendMessage).toHaveBeenCalledWith(2, { type: "settings.changed" });
  });

  it("内容脚本按地址匹配失败时，回退全量查询仍通知扩展设置页", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("无法按地址查询"))
      .mockResolvedValueOnce([{ id: 3 }, { id: 4 }])
      .mockResolvedValueOnce([{ id: 4 }, { id: 5 }]);
    vi.stubGlobal("chrome", {
      tabs: { query, sendMessage },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });
    const ctx = context();
    const response = await handleRequest(
      { type: "settings.setPolicy", patch: {} },
      ctx
    );
    expect(response.ok).toBe(true);
    expect(query).toHaveBeenNthCalledWith(1, { url: expect.any(Array) });
    expect(query).toHaveBeenNthCalledWith(2, {});
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 3, { type: "settings.changed" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 4, { type: "settings.changed" });
    expect(sendMessage).toHaveBeenNthCalledWith(3, 5, { type: "settings.changed" });
  });

  it("保存决策设置后通知所有标签页重读，并规范化落盘", async () => {
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi
          .fn()
          .mockResolvedValueOnce([{ id: 1 }])
          .mockResolvedValueOnce([]),
        sendMessage
      },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });
    const ctx = context();
    const response = await handleRequest(
      {
        type: "settings.setDecisionConfig",
        patch: {
          endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
          apiKey: "key-1",
          model: "gemini-decision-1"
        }
      },
      ctx
    );
    expect(response.ok).toBe(true);
    expect(await readDecisionConfig(ctx.area)).toMatchObject({
      endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
      apiKey: "key-1",
      model: "gemini-decision-1"
    });
    expect(sendMessage).toHaveBeenCalledWith(1, { type: "settings.changed" });
  });

  it("并发 ignore.add 不互相覆盖", async () => {
    const ctx = context();
    await Promise.all([
      handleRequest({ type: "ignore.add", videoKey: "v", segmentKey: "1.00-2.00" }, ctx),
      handleRequest({ type: "ignore.add", videoKey: "v", segmentKey: "3.00-4.00" }, ctx)
    ]);
    const response = await handleRequest({ type: "ignore.get", videoKey: "v" }, ctx);
    expect(response.ok && response.value).toEqual(["1.00-2.00", "3.00-4.00"]);
  });

  it("badge.set 只对带 tab id 的发送者写角标", async () => {
    const setBadgeText = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { action: { setBadgeText } });
    await handleRequest({ type: "badge.set", text: "AD 2" }, context());
    expect(setBadgeText).not.toHaveBeenCalled();
    await handleRequest({ type: "badge.set", text: "AD 2" }, context({ senderTabId: 7 }));
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "AD 2" });
  });

  it("未配置 LLM 时 llm.complete 返回 not_configured", async () => {
    const response = await handleRequest(
      { type: "llm.complete", messages: [{ role: "user", content: "hi" }] },
      context()
    );
    expect(response).toEqual({
      ok: false,
      error: { kind: "not_configured", message: expect.any(String) }
    });
  });

  it("未知请求返回结构化错误，未捕获异常也被包住", async () => {
    const unknown = await handleRequest({ type: "nope" } as never, context());
    expect(unknown.ok).toBe(false);
    const failing = context({
      area: {
        get: async () => {
          throw new Error("storage down");
        },
        set: async () => {},
        remove: async () => {}
      }
    });
    const wrapped = await handleMessage({ type: "settings.get" }, failing);
    expect(wrapped).toMatchObject({ ok: false, error: { kind: "internal" } });
  });
});

describe("决策接口代发", () => {
  const questions = { is_ad: { type: "noul" as const, instructions: "有没有广告？" } };
  const input = [{ type: "text" as const, text: "00:00-01:00 本期由赞助商提供" }];

  it("没配决策接口时返回 not_configured，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleRequest({ type: "decision.decide", input, questions }, context());
    expect(response).toEqual({
      ok: false,
      error: { kind: "not_configured", message: expect.any(String) }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配好之后代发到用户填的完整地址，Key 只出现在请求头里", async () => {
    const ctx = context();
    await writeDecisionConfig(ctx.area, {
      endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
      apiKey: "key-1",
      model: "gemini-decision-1"
    });
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) => {
        // 参数在断言里用，这里只是为了拿到类型化的 mock.calls。
        void url;
        void init;
        return new Response(
          JSON.stringify({
            answers: { is_ad: { type: "noul", noul: 0.93, confidence: 0.93 } }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest({ type: "decision.decide", input, questions }, ctx);
    expect(response).toMatchObject({ ok: true, value: { answers: { is_ad: { noul: 0.93 } } } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "key-1" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gemini-decision-1" });
    expect(JSON.stringify(body)).not.toContain("key-1");
  });

  it("决策重试耗尽后只返回错误类别", async () => {
    const ctx = context();
    await writeDecisionConfig(ctx.area, {
      endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
      apiKey: "key-1",
      model: "gemini-decision-1"
    });
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 503 })));
      const pending = handleRequest(
        { type: "decision.decide", input, questions },
        ctx
      );
      // 无时长预算 2 分钟，默认每次等 1 秒，走完 120 次重试。
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
      const response = await pending;
      expect(response).toMatchObject({
        ok: false,
        error: { kind: "server" }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("模型不存在时直接报错", () => {
  it("不换模型、不重发，配置保持不变", async () => {
    const ctx = context();
    await saveConnection(ctx.area, "deepseek", {
      model: "old-model",
      apiKey: "sk-test",
      jsonObject: true,
      connectedAt: 0
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 })
      )
    );

    const response = await handleRequest(
      { type: "llm.complete", messages: [{ role: "user", content: "hi" }] },
      ctx
    );

    expect(response).toMatchObject({ ok: false, error: { kind: "not_found" } });
    const stored = await readLlmConfig(ctx.area);
    expect(stored?.byProvider.deepseek?.model).toBe("old-model");
  });

  it("成功时后台只返回正文字符串", async () => {
    const ctx = context();
    await saveConnection(ctx.area, "deepseek", {
      model: "deepseek-chat",
      apiKey: "sk-test",
      jsonObject: true,
      connectedAt: 0
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"ok\":true}" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const response = await handleRequest(
      { type: "llm.complete", messages: [{ role: "user", content: "hi" }] },
      ctx
    );
    expect(response).toEqual({ ok: true, value: "{\"ok\":true}" });
  });
});

describe("设置读取", () => {
  it("settings.get 一次读全四份设置，不再分四次往返", async () => {
    const area = createMemoryStorageArea();
    const gets: Array<string | string[] | null | undefined> = [];
    const original = area.get.bind(area);
    area.get = (keys) => {
      gets.push(keys);
      return original(keys);
    };
    const response = await handleRequest({ type: "settings.get" }, context({ area }));
    expect(response.ok).toBe(true);
    // 一次数组读取就是全部设置；不能出现逐键的四连读。
    const keyReads = gets.filter((keys) => Array.isArray(keys));
    expect(keyReads).toHaveLength(1);
    expect(new Set(keyReads[0])).toEqual(
      new Set(["analysis", "llm", "site-switches", "decision"])
    );
  });
});

describe("跳过统计", () => {
  it("跳过与撤销分别累计，读回只有三个数字", async () => {
    const ctx = context();
    await handleRequest({ type: "metrics.skip", seconds: 30 }, ctx);
    await handleRequest({ type: "metrics.skip", seconds: 12 }, ctx);
    await handleRequest({ type: "metrics.undo" }, ctx);
    const response = await handleRequest({ type: "metrics.get" }, ctx);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value).toEqual({
      skippedSegments: 2,
      savedSeconds: 42,
      undoCount: 1
    });
  });
});

describe("设置变更通知", () => {
  it("分别查内容脚本标签页与设置页，命中才推送", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ id: 8 }]);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { query, sendMessage },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });

    await handleRequest({ type: "settings.setPolicy", patch: {} }, context());

    expect(query).toHaveBeenCalledTimes(2);
    const [queryInfo] = query.mock.calls[0] as unknown as [{ url: string[] }];
    expect(queryInfo.url).toEqual(
      expect.arrayContaining(["https://www.youtube.com/watch*", "https://www.bilibili.com/video/*"])
    );
    expect(query.mock.calls[1]).toEqual([{ url: "chrome-extension://test/options.html" }]);
    expect(sendMessage).toHaveBeenCalledWith(7, { type: "settings.changed" });
    expect(sendMessage).toHaveBeenCalledWith(8, { type: "settings.changed" });
  });

  it("按地址查询不可用时退回全量查询，推送仍然发出", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("no host permission"))
      .mockResolvedValueOnce([{ id: 9 }])
      .mockResolvedValueOnce([]);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { query, sendMessage },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });

    await handleRequest({ type: "settings.setPolicy", patch: {} }, context());

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]).toEqual([{}]);
    expect(sendMessage).toHaveBeenCalledWith(9, { type: "settings.changed" });
  });
});

