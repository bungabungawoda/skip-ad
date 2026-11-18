import { describe, expect, it, vi } from "vitest";
import { createDecisionClient, decisionEndpoint } from "../client";
import { decisionProtocol } from "../protocol";
import type { DecisionQuestion } from "../types";
import type { FetchLike } from "../../../lib/http";

const connection = {
  endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
  apiKey: "key-1",
  model: "gemini-decision-1"
};

const typesafeConnection = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  apiKey: "sk-test",
  model: "jev-latest"
};

const questions: Record<string, DecisionQuestion> = {
  is_ad: { type: "noul", instructions: "这一分钟里有没有广告？" },
  kind: {
    type: "choice",
    instructions: "属于哪一类？",
    criteria: { sponsor: "商单口播", topic: "正常内容" }
  }
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

const okBody = {
  answers: {
    is_ad: { type: "noul", noul: 0.93, confidence: 0.93 },
    kind: {
      type: "choice",
      choice: "sponsor",
      probabilities: { sponsor: 0.93, topic: 0.07 },
      confidence: 0.93
    }
  },
};

const typesafeOkBody = {
  answers: {
    is_ad: { type: "noul", noul: 0.93 },
    kind: {
      type: "choice",
      choice: "sponsor",
      probabilities: { sponsor: 0.93, topic: 0.07 },
      confidence: 0.93
    }
  }
};

const input = [{ type: "text" as const, text: "00:00-01:00 本期视频由赞助商提供" }];

describe("决策客户端", () => {
  it("请求打到配置的完整地址，带 x-goog-api-key，返回概率", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(okBody));
    const client = createDecisionClient(connection, { fetchImpl: fetchMock });
    const result = await client.decide({ input, questions });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "key-1" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gemini-decision-1", questions });
    expect(body.input).toEqual(input);
    expect(body).not.toHaveProperty("state");
    expect(result.answers.is_ad).toMatchObject({ type: "noul", noul: 0.93 });
  });

  it("TypeSafe 地址用 Bearer 和 state，noul 可以没有 confidence", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(typesafeOkBody));
    const client = createDecisionClient(typesafeConnection, { fetchImpl: fetchMock });
    const result = await client.decide({ input, questions });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(init?.headers).not.toHaveProperty("x-goog-api-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "jev-latest",
      state: "00:00-01:00 本期视频由赞助商提供",
      questions
    });
    expect(body).not.toHaveProperty("input");
    expect(result.answers.is_ad).toEqual({ type: "noul", noul: 0.93 });
  });

  it("TypeSafe 把 Google 写法的 noul criteria 换成 true/false", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(typesafeOkBody));
    const client = createDecisionClient(typesafeConnection, { fetchImpl: fetchMock });
    await client.decide({
      input,
      questions: {
        is_ad: {
          type: "noul",
          instructions: "这一分钟里有没有广告？",
          criteria: { true_description: "广告", false_description: "正常内容" }
        }
      }
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    expect(body.questions.is_ad?.criteria).toEqual({ true: "广告", false: "正常内容" });
  });

  it("没有 Key 时不发任何鉴权头，TypeSafe 本地网关也能尝试", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(typesafeOkBody));
    const client = createDecisionClient(
      { ...typesafeConnection, apiKey: "" },
      { fetchImpl: fetchMock }
    );
    await client.decide({ input, questions });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(init?.headers).not.toHaveProperty("x-goog-api-key");
  });

  it("只去掉末尾斜杠，不替用户补路径", () => {
    expect(decisionEndpoint(" https://example.com/custom/decisions/ ")).toBe(
      "https://example.com/custom/decisions"
    );
    expect(decisionEndpoint("https://example.com/custom")).toBe("https://example.com/custom");
  });

  it("没有 Key 时不发 x-goog-api-key，本地网关可以直接用", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(okBody));
    const client = createDecisionClient(
      { ...connection, apiKey: "" },
      { fetchImpl: fetchMock }
    );
    await client.decide({ input, questions });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty("x-goog-api-key");
  });

  it("缺答案算形状错误，不当成 0 分", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ answers: { is_ad: okBody.answers.is_ad }, usage: {} })
    );
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, retry: false });
    await expect(client.decide({ input, questions })).rejects.toMatchObject({ kind: "shape" });
  });

  it("选项不在本地给的表里算形状错误", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        answers: {
          is_ad: okBody.answers.is_ad,
          kind: {
            type: "choice",
            choice: "advertorial",
            probabilities: { advertorial: 1 },
            confidence: 1
          }
        },
        usage: {}
      })
    );
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, retry: false });
    await expect(client.decide({ input, questions })).rejects.toThrow(/不存在的选项/);
  });

  it("429 按 Retry-After 等一次再重试", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(okBody));
    const sleep = vi.fn(async () => undefined);
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep });
    const result = await client.decide({ input, questions });
    expect(result.answers.is_ad).toMatchObject({ noul: 0.93 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("429 正文里的等待按服务端要求等", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message:
                "Rate limit exceeded for model gemini-decision-1 (limit: 50000 input tokens per minute on Free Tier). Please retry in 37s or upgrade your tier at https://ai.dev/rate-limit.",
              code: "too_many_requests"
            }
          },
          429
        )
      )
      .mockResolvedValueOnce(jsonResponse(okBody));
    const sleep = vi.fn(async () => undefined);
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep });
    const result = await client.decide({ input, questions });
    expect(result.answers.is_ad).toMatchObject({ noul: 0.93 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(37_000);
  });

  it("Google 429 同时有 Header 和正文时按正文等待", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: "Rate limit exceeded. Please retry in 37s."
            }
          },
          429,
          { "retry-after": "2" }
        )
      )
      .mockResolvedValueOnce(jsonResponse(okBody));
    const sleep = vi.fn(async () => undefined);
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep });
    await client.decide({ input, questions });
    expect(sleep).toHaveBeenCalledWith(37_000);
  });

  it("TypeSafe 429 固定等 30 秒，忽略响应里的等待建议", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "slow down", retry_after_seconds: 5 },
          429,
          { "retry-after": "2" }
        )
      )
      .mockResolvedValueOnce(jsonResponse(typesafeOkBody));
    const sleep = vi.fn(async () => undefined);
    const client = createDecisionClient(typesafeConnection, { fetchImpl: fetchMock, sleep });
    await client.decide({ input, questions });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("连续 429 按累计等待预算重试", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => jsonResponse({ error: "limit" }, 429, { "retry-after": "60" })
    );
    const sleep = vi.fn(async (ms: number) => {
      void ms;
    });
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep });
    await expect(client.decide({ input, questions })).rejects.toMatchObject({
      kind: "rate_limit"
    });
    // 无时长预算 2 分钟，每次等 60 秒：重试 2 次。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([60_000, 60_000]);
  });

  it("长视频遇到连续 429 会按视频长度多试几次", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => jsonResponse({ error: "limit" }, 429, { "retry-after": "60" })
    );
    const client = createDecisionClient(connection, {
      fetchImpl: fetchMock,
      sleep: async () => {},
      videoDurationMs: 30 * 60_000
    });
    await expect(client.decide({ input, questions })).rejects.toMatchObject({
      kind: "rate_limit"
    });
    // 预算 15 分钟，每次等 60 秒：重试 15 次。
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it("鉴权失败不重试", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: "bad key" }, 401));
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep: async () => undefined });
    await expect(client.decide({ input, questions })).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 按累计等待预算重试", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: "overloaded" }, 503));
    const client = createDecisionClient(connection, { fetchImpl: fetchMock, sleep: async () => undefined });
    await expect(client.decide({ input, questions })).rejects.toMatchObject({ kind: "server" });
    // 服务端没给等待建议时用 1 秒默认退避，2 分钟预算内重试 120 次。
    expect(fetchMock).toHaveBeenCalledTimes(121);
  });

  it("取消后立刻以 cancelled 结束", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return jsonResponse(okBody);
    });
    const client = createDecisionClient(connection, { fetchImpl: fetchMock });
    await expect(
      client.decide({ input, questions, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

});

describe("决策协议识别", () => {
  it.each([
    ["https://generativelanguage.googleapis.com/v1beta/decisions", "google"],
    ["https://api.typesafe.ai/v1/systemone", "typesafe"],
    ["https://typesafe-proxy.example.com/v1/systemone", "typesafe"],
    ["https://gateway.example.com/custom/systemone/", "typesafe"],
    ["https://gateway.example.com/v1/decisions", "google"]
  ] as const)("%s 识别为 %s", (endpoint, expected) => {
    expect(decisionProtocol(endpoint)).toBe(expected);
  });
});
