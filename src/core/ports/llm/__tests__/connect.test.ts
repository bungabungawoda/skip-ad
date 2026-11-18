import { describe, expect, it, vi } from "vitest";
import { connect } from "../connect";
import type { FetchLike } from "../../../lib/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const chatAnswer = (): Response =>
  jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] });

function route(handler: (url: string, init?: RequestInit) => Response): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as FetchLike;
}

describe("connect", () => {
  it("picks the newest cheap model from the list and probes json support", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => {
        calls.push(url);
        if (url.endsWith("/models")) {
          return jsonResponse({
            data: [
              { id: "gpt-4o", created: 200 },
              { id: "gpt-4o-mini", created: 100 },
              { id: "text-embedding-3-small", created: 300 }
            ]
          });
        }
        return chatAnswer();
      })
    );

    const result = await connect(
      { providerId: "openai", apiKey: "sk-test" },
      { fetchImpl, now: () => 1234 }
    );

    expect(result.entry).toEqual({
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      jsonObject: true,
      connectedAt: 1234
    });
    expect(result.notes).toEqual([]);
    expect(calls).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/chat/completions"
    ]);
  });

  it("falls back to the preset model when the list is unavailable", async () => {
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => (url.endsWith("/models") ? new Response("no", { status: 404 }) : chatAnswer()))
    );
    const result = await connect({ providerId: "deepseek", apiKey: "sk" }, { fetchImpl });
    expect(result.entry.model).toBe("deepseek-chat");
    expect(result.notes).toHaveLength(1);
  });

  it("turns json mode off when the endpoint rejects it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url, init) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "glm-4-flash" }] });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return body.response_format ? new Response("bad field", { status: 400 }) : chatAnswer();
      })
    );

    const result = await connect({ providerId: "zhipu", apiKey: "sk" }, { fetchImpl });
    expect(result.entry.jsonObject).toBe(false);
    expect(bodies[0]?.response_format).toBeDefined();
    expect(bodies[1]?.response_format).toBeUndefined();
  });

  it("surfaces auth failures instead of retrying", async () => {
    const fetchImpl = vi.fn<FetchLike>(route(() => new Response("nope", { status: 401 })));
    await expect(connect({ providerId: "deepseek", apiKey: "bad" }, { fetchImpl })).rejects.toMatchObject(
      { kind: "auth" }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the anthropic protocol for a preset endpoint", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url, init) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        return jsonResponse({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" });
      })
    );
    const result = await connect({ providerId: "anthropic", apiKey: "sk-ant" }, { fetchImpl });
    expect(result.entry).toMatchObject({ model: "claude-sonnet-4-5", jsonObject: false });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[1]?.headers["x-api-key"]).toBe("sk-ant");
  });

  it("detects the protocol of a custom endpoint that already names it", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => {
        urls.push(url);
        return jsonResponse({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" });
      })
    );
    const result = await connect(
      {
        providerId: "custom",
        apiKey: "sk",
        baseUrl: "https://proxy.example.com/v1/messages",
        model: "claude-x"
      },
      { fetchImpl }
    );
    expect(result.entry.protocol).toBe("anthropic");
    expect(urls[0]).toBe("https://proxy.example.com/v1/messages");
  });

  it("probes protocols in order for a bare custom endpoint", async () => {
    const tried: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => {
        tried.push(url);
        if (url.endsWith("/chat/completions")) return new Response("no", { status: 404 });
        return jsonResponse({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" });
      })
    );
    const result = await connect(
      { providerId: "custom", apiKey: "sk", baseUrl: "https://proxy.example.com", model: "m" },
      { fetchImpl }
    );
    expect(result.entry.protocol).toBe("anthropic");
    expect(tried.slice(0, 2)).toEqual([
      "https://proxy.example.com/chat/completions",
      "https://proxy.example.com/v1/messages"
    ]);
  });

  it("stops probing protocols when a custom endpoint rejects the key", async () => {
    const tried: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => {
        tried.push(url);
        return new Response("bad key", { status: 401 });
      })
    );
    await expect(
      connect(
        { providerId: "custom", apiKey: "sk", baseUrl: "https://proxy.example.com", model: "m" },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ kind: "auth" });
    // Key 不对与协议无关：换另外两种协议只会再打两次无用请求。
    expect(tried).toHaveLength(1);
  });

  it("rejects a custom endpoint without an address or model", async () => {
    const fetchImpl = vi.fn<FetchLike>(route(() => chatAnswer()));
    await expect(
      connect({ providerId: "custom", apiKey: "sk", model: "m" }, { fetchImpl })
    ).rejects.toMatchObject({ kind: "bad_request" });
    await expect(
      connect({ providerId: "custom", apiKey: "sk", baseUrl: "https://x.example.com" }, { fetchImpl })
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("protocol probing failures", () => {
  it("reports the auth failure when every protocol fails but one says 401", async () => {
    const fetchImpl = vi.fn<FetchLike>(
      route((url) => {
        if (url.endsWith("/chat/completions")) return new Response("bad", { status: 400 });
        if (url.endsWith("/messages")) return new Response("no auth", { status: 401 });
        return new Response("boom", { status: 500 });
      })
    );
    await expect(
      connect(
        { providerId: "custom", apiKey: "sk", baseUrl: "https://proxy.example.com", model: "m" },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("returns the first error when nothing is usable", async () => {
    const fetchImpl = vi.fn<FetchLike>(
      route(() => new Response("boom", { status: 500 }))
    );
    await expect(
      connect(
        { providerId: "custom", apiKey: "sk", baseUrl: "https://proxy.example.com", model: "m" },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ kind: "server" });
  });
});
