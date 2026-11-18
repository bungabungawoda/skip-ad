import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeResponse, RuntimeSettings } from "../messages";
import {
  createRuntimeCache,
  createRuntimeDecisionClient,
  createRuntimeLlmClient,
  readRuntimeSettings
} from "../runtime-client";
import type { DecisionResult } from "../decision/types";
import { DEFAULT_POLICY } from "../../policy/policy";

function mockChrome(sendMessage: (message: unknown) => Promise<unknown>): void {
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime client", () => {
  it("reads runtime settings", async () => {
    const settings: RuntimeSettings = {
      policy: DEFAULT_POLICY,
      llmConfigured: true,
      decisionConfigured: false,
      analysisConfigured: true,
      model: "deepseek-chat",
      siteSwitches: {}
    };
    mockChrome(async () => ({ ok: true, value: settings }) satisfies RuntimeResponse<RuntimeSettings>);
    await expect(readRuntimeSettings()).resolves.toEqual(settings);
  });

  it("throws when the background returns an error", async () => {
    mockChrome(async () => ({ ok: false, error: { kind: "auth", message: "bad key" } }));
    await expect(readRuntimeSettings()).rejects.toMatchObject({ kind: "auth", message: "bad key" });
  });

  it("passes LLM messages through and maps failures", async () => {
    mockChrome(async () => ({ ok: true, value: '{"ok":true}' }));
    await expect(
      createRuntimeLlmClient().complete([{ role: "user", content: "hi" }])
    ).resolves.toBe('{"ok":true}');

    mockChrome(async () => ({ ok: false, error: { kind: "rate_limit", message: "slow" } }));
    await expect(createRuntimeLlmClient().complete([])).rejects.toMatchObject({
      kind: "rate_limit"
    });
  });

  it("gives every proxied request a distinct id with a per-tab salt", async () => {
    const ids: string[] = [];
    mockChrome(async (message) => {
      const request = message as { requestId?: string };
      if (request.requestId) ids.push(request.requestId);
      return { ok: true, value: "{}" };
    });
    const client = createRuntimeLlmClient();
    await client.complete([{ role: "user", content: "a" }]);
    await client.complete([{ role: "user", content: "b" }]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // 时间戳加序号之外还有一段随机盐：两个标签页同一毫秒发请求也不会撞 id。
    expect(ids[0]).toMatch(/^llm-[a-z0-9]{6}-/);
  });

  it("proxies cache operations", async () => {
    const send = vi.fn(async () => ({ ok: true, value: null }));
    mockChrome(send);
    const cache = createRuntimeCache();
    await expect(cache.get("k")).resolves.toBeNull();
    await cache.set("k", {
      result: {
        videoKey: "k",
        video: { site: "bilibili", videoId: "BV1", partId: "1" },
        mode: "full",
        segments: [],
        warnings: [],
        durationSec: 0
      },
      createdAt: 0
    });
    await cache.delete("k");
    await cache.clear();
    expect(send).toHaveBeenCalledWith({ type: "cache.get", key: "k" });
    expect(send).toHaveBeenCalledWith({
      type: "cache.set",
      key: "k",
      entry: expect.objectContaining({ createdAt: 0 })
    });
    expect(send).toHaveBeenCalledWith({ type: "cache.delete", key: "k" });
    expect(send).toHaveBeenCalledWith({ type: "cache.clear" });
  });

  it("后台删除缓存失败时代理返回 false", async () => {
    mockChrome(async () => ({ ok: false, error: { kind: "internal", message: "storage 删除失败" } }));
    await expect(createRuntimeCache().delete("k")).resolves.toBe(false);
  });

  it("reports a missing background", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: async () => {
          throw new Error("Could not establish connection");
        }
      }
    });
    await expect(readRuntimeSettings()).rejects.toMatchObject({ kind: "disconnected" });
  });
});

const decisionResult: DecisionResult = {
  answers: {}
};

describe("决策请求的后台代理", () => {
  const input = [{ text: "一段台词", type: "text" as const }];
  const questions = {};

  it("把输入和问题表转给后台，带上 requestId", async () => {
    const send = vi.fn<(message: unknown) => Promise<{ ok: true; value: DecisionResult }>>(
      async () => ({ ok: true, value: decisionResult })
    );
    mockChrome(send);
    await expect(createRuntimeDecisionClient().decide({ input, questions })).resolves.toEqual(
      decisionResult
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "decision.decide",
      input,
      questions
    });
    expect(
      (send.mock.calls[0]?.[0] as { requestId?: string }).requestId
    ).toMatch(/^decision-/);
  });

  it("决策请求 id 带每标签页随机盐，连续两次不重复", async () => {
    const ids: string[] = [];
    mockChrome(async (message) => {
      ids.push((message as { requestId?: string }).requestId ?? "");
      return { ok: true, value: decisionResult };
    });
    const client = createRuntimeDecisionClient();
    await client.decide({ input, questions });
    await client.decide({ input, questions });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^decision-[a-z0-9]{6}-/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("后台的业务错误按原来的 kind 抛给调用方", async () => {
    mockChrome(async () => ({ ok: false, error: { kind: "rate_limit", message: "slow" } }));
    await expect(
      createRuntimeDecisionClient().decide({ input, questions })
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("已经取消的请求不打扰后台", async () => {
    const send = vi.fn<(message: unknown) => Promise<{ ok: true; value: DecisionResult }>>(
      async () => ({ ok: true, value: decisionResult })
    );
    mockChrome(send);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createRuntimeDecisionClient().decide({ input, questions, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("请求在途时取消会发一条同 id 的 decision.abort", async () => {
    const sent: Array<{ type: string; requestId?: string }> = [];
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    mockChrome(async (message) => {
      const request = message as { type: string; requestId?: string };
      sent.push(request);
      return request.type === "decision.decide" ? pending : { ok: true, value: null };
    });

    const controller = new AbortController();
    const promise = createRuntimeDecisionClient().decide({
      input,
      questions,
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();
    release({ ok: true, value: decisionResult });
    await expect(promise).resolves.toEqual(decisionResult);

    expect(sent.map((request) => request.type)).toEqual(["decision.decide", "decision.abort"]);
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
  });
});
