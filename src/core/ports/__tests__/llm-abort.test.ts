import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmAbortRegistry } from "../llm-abort";
import { createRuntimeLlmClient } from "../runtime-client";
import { createLlmClient } from "../llm/client";
import type { ResolvedConnection } from "../llm/config";
import type { FetchLike } from "../../lib/http";

const connection: ResolvedConnection = {
  providerId: "deepseek",
  preset: undefined,
  protocol: "openai-chat",
  baseUrl: "https://example.com/v1",
  model: "m",
  apiKey: "",
  jsonObject: true,
  autoPrefixCache: true
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("取消信号", () => {
  it("abort registry 能按 requestId 中止对应请求", () => {
    const registry = createLlmAbortRegistry();
    const first = registry.create("a");
    const second = registry.create("b");
    expect(registry.abort("a")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.abort("missing")).toBe(false);
    registry.release("a");
    registry.release("b");
  });

  it("LLM 客户端把外部 signal 传给 fetch，并归类为 cancelled 而不是 timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const promise = createLlmClient(connection, { fetchImpl }).complete([], {
      signal: controller.signal
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("runtime 代理在取消时发送 llm.abort 消息并带上 requestId", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const send = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => pending);
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
    const controller = new AbortController();
    const promise = createRuntimeLlmClient().complete([], { signal: controller.signal });
    const first = send.mock.calls[0]?.[0] as { type: string; requestId?: string } | undefined;
    expect(first?.type).toBe("llm.complete");
    expect(first?.requestId).toBeTruthy();
    controller.abort();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({ type: "llm.abort", requestId: first?.requestId });
    release({ ok: true, value: "{}" });
    await expect(promise).resolves.toBe("{}");
  });

  it("请求已完成时不再响应取消", async () => {
    const send = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      ok: true,
      value: "{}"
    }));
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
    const controller = new AbortController();
    await expect(
      createRuntimeLlmClient().complete([], { signal: controller.signal })
    ).resolves.toBe("{}");
    controller.abort();
    await Promise.resolve();
    expect(
      send.mock.calls.filter((call) => (call[0] as { type: string }).type === "llm.abort")
    ).toHaveLength(0);
  });
});
