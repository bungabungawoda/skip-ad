import { describe, expect, it, vi } from "vitest";
import { createLlmClient } from "../client";
import type { ResolvedConnection } from "../config";
import type { FetchLike } from "../../../lib/http";

const chat: ResolvedConnection = {
  providerId: "deepseek",
  preset: undefined,
  protocol: "openai-chat",
  baseUrl: "https://api.example.com",
  model: "test-model",
  apiKey: "sk-test",
  jsonObject: true,
  autoPrefixCache: true
};

const messages = [
  { role: "system" as const, content: "system prompt" },
  { role: "user" as const, content: "user content" }
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const answer = (text: string, extra: Record<string, unknown> = {}): Response =>
  jsonResponse({ choices: [{ message: { content: text } }], ...extra });

describe("LLM client", () => {
  it("posts a chat request to the resolved endpoint and returns the text", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => answer("hello"));
    const client = createLlmClient(chat, { fetchImpl: fetchMock });
    const result = await client.complete(messages);

    expect(result).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.com/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user content" }
      ],
      response_format: { type: "json_object" }
    });
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("expands the output limit once when a reply is truncated, then gives up", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? answer("{\"segments\":[", { choices: [{ message: { content: "{\"segments\":[" }, finish_reason: "length" }] })
        : answer("done");
    });
    const client = createLlmClient(chat, { fetchImpl: fetchMock, sleep: async () => {} });
    const result = await client.complete(messages);
    expect(result).toBe("done");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.max_tokens).toBe(4096);
    expect(bodies[1]?.max_tokens).toBe(8192);

    const alwaysTruncated = vi.fn<FetchLike>(async () =>
      answer("{", { choices: [{ message: { content: "{" }, finish_reason: "length" }] })
    );
    const stubborn = createLlmClient(chat, {
      fetchImpl: alwaysTruncated,
      sleep: async () => {}
    });
    await expect(stubborn.complete(messages)).rejects.toMatchObject({ kind: "truncated" });
    expect(alwaysTruncated).toHaveBeenCalledTimes(2);
  });

  it("expands the output limit when a proxy reports an empty reasoning reply", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? new Response(
            JSON.stringify({
              error: {
                message:
                  "WorkBuddy AI: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning"
              }
            }),
            { status: 502, headers: { "content-type": "application/json" } }
          )
        : answer("done");
    });
    const client = createLlmClient(chat, { fetchImpl: fetchMock, sleep: async () => {} });

    const result = await client.complete(messages);

    expect(result).toBe("done");
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 8192]);
  });

  it("stops after one expansion when the reasoning reply stays empty", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "WorkBuddy AI: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning"
            }
          }),
          { status: 502, headers: { "content-type": "application/json" } }
        )
    );
    const client = createLlmClient(chat, { fetchImpl: fetchMock, sleep: async () => {} });

    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "truncated" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("calls fetch without a receiver so native fetch stays callable in a worker", async () => {
    // 原生 fetch 被当成对象方法调用时 this 会变成那个对象，Service Worker 里
    // 直接抛 "Illegal invocation"。mock 函数不校验 this，所以这里显式断言。
    let receiverWasUndefined: boolean | null = null;
    const fetchMock = function (this: unknown): Promise<Response> {
      receiverWasUndefined = this === undefined;
      return Promise.resolve(answer("hello"));
    } as unknown as FetchLike;
    const client = createLlmClient(chat, { fetchImpl: fetchMock });
    await client.complete(messages);
    expect(receiverWasUndefined).toBe(true);
  });

  it("speaks anthropic when the connection says so", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
    );
    const client = createLlmClient(
      { ...chat, protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
      { fetchImpl: fetchMock }
    );
    const result = await client.complete(messages);

    expect(result).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.system).toBe("system prompt");
    expect(body.max_tokens).toBe(4096);
    expect(init?.headers).toMatchObject({ "x-api-key": "sk-test" });
  });

  it("does not retry auth failures", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response("nope", { status: 401 }));
    const client = createLlmClient(chat, { fetchImpl: fetchMock, sleep: async () => {} });
    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);  });

  it("rate limit 按累计 2 分钟预算重试，用尽后放弃", async () => {
    // 服务端每次让等 37 秒：3 次等待 111 秒，第 4 次要等 148 秒超过预算，停止。
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "37" }
        })
    );
    const delays: number[] = [];
    const client = createLlmClient(chat, {
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });
    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([37_000, 37_000, 37_000]);
  });

  it("长视频遇到限流会多试几次，每次按服务端建议等待", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "60" }
        })
    );
    const delays: number[] = [];
    const client = createLlmClient(chat, {
      fetchImpl: fetchMock,
      videoDurationMs: 30 * 60_000,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });
    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "rate_limit" });
    // 30 分钟视频预算 15 分钟，每次等 60 秒：重试 15 次。
    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(delays).toHaveLength(15);
    expect(delays.every((ms) => ms === 60_000)).toBe(true);
  });

  it("退避期间取消会立刻停止重试，不等 Retry-After 睡完", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response("slow down", {
          status: 429,
          // 在 2 分钟预算内，才会进入等待；取消要能立刻打断这场等待。
          headers: { "retry-after": "60" }
        })
    );
    let sleeping = false;
    const client = createLlmClient(chat, {
      fetchImpl: fetchMock,
      // 一个永远不结束的退避：只有取消信号能打断它。
      sleep: () =>
        new Promise<void>(() => {
          sleeping = true;
        })
    });

    const pending = client.complete(messages, { signal: controller.signal });
    await vi.waitFor(() => expect(sleeping).toBe(true));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours the retry-after header", async () => {
    let calls = 0;
    const fetchMock = vi.fn<FetchLike>(async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
        : answer("ok");
    });
    const delays: number[] = [];
    await createLlmClient(chat, {
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        delays.push(ms);
      }
    }).complete(messages);
    expect(delays).toEqual([7000]);
  });

  it("retries a timeout once and reports timeout", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      });
    const fetchMock = vi.fn<FetchLike>(hanging);
    const client = createLlmClient(chat, {
      fetchImpl: fetchMock,
      timeoutMs: 5,
      sleep: async () => {}
    });
    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an unknown response shape as a shape error", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })
    );
    const client = createLlmClient(chat, { fetchImpl: fetchMock, sleep: async () => {} });
    await expect(client.complete(messages)).rejects.toMatchObject({ kind: "shape" });
    // 形状错误也会重试，直到 2 分钟累计等待预算用尽。
    expect(fetchMock).toHaveBeenCalledTimes(121);
  });

  it("reports cancellation instead of timeout", async () => {
    // 与真实 fetch 一致：已经中止的 signal 直接失败，不等事件。
    const fetchMock = vi.fn<FetchLike>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const fail = (): void => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail);
        })
    );
    const controller = new AbortController();
    controller.abort();
    const client = createLlmClient(chat, { fetchImpl: fetchMock, timeoutMs: 50 });
    await expect(client.complete(messages, { signal: controller.signal })).rejects.toMatchObject({
      kind: "cancelled"
    });
  });

  it("distinguishes a missing model from a wrong path", async () => {
    const missing = createLlmClient(chat, {
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: { code: "model_not_found" } }, 404)
      )
    });
    await expect(missing.complete(messages)).rejects.toMatchObject({ kind: "not_found" });

    const wrongPath = createLlmClient(chat, {
      fetchImpl: vi.fn(async () => new Response("not found", { status: 404 }))
    });
    await expect(wrongPath.complete(messages)).rejects.toMatchObject({ kind: "path_not_found" });
  });
});
