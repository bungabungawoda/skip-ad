import { describe, expect, it } from "vitest";
import {
  anthropic,
  detectProtocolFromUrl,
  openaiChat,
  openaiResponses,
  protocolById
} from "../protocols";
import type { BuildInput } from "../protocols/types";

const input: BuildInput = {
  baseUrl: "https://api.example.com",
  model: "test-model",
  apiKey: "sk-test",
  messages: [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user content" }
  ],
  maxOutputTokens: 4096,
  temperature: 0.1,
  jsonObject: true
};

const conversation: BuildInput = {
  ...input,
  messages: [
    { role: "system", content: "system prompt" },
    { role: "user", content: "第 1 段证据" },
    { role: "assistant", content: '{"segments":[]}' },
    { role: "user", content: "第 2 段证据" }
  ]
};

describe("protocol: openai-chat", () => {
  it("appends the chat path to a bare base url", () => {
    expect(openaiChat.resolveUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/chat/completions"
    );
    expect(openaiChat.resolveUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
    expect(openaiChat.resolveUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });

  it("keeps a full endpoint url untouched", () => {
    const full = "https://api.deepseek.com/chat/completions";
    expect(openaiChat.resolveUrl(full)).toBe(full);
  });

  it("rejects addresses that are not http", () => {
    expect(openaiChat.resolveUrl("ftp://x/y")).toBeNull();
    expect(openaiChat.resolveUrl("not a url")).toBeNull();
  });

  it("builds a chat request with system prompt in messages", () => {
    const request = openaiChat.build(input);
    expect(request.url).toBe("https://api.example.com/chat/completions");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test"
    });
    expect(request.body).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user content" }
      ],
      // 必须显式带上上限：服务端默认 4096 会把长片段表截断。
      max_tokens: 4096,
      temperature: 0.1,
      stream: false,
      response_format: { type: "json_object" }
    });
  });

  it("passes the whole conversation through so provider prefix caches can hit", () => {
    const request = openaiChat.build(conversation);
    expect(request.body.messages).toEqual(conversation.messages);
  });

  it("drops the json field when the capability is off and the key is empty", () => {
    const request = openaiChat.build({ ...input, jsonObject: false, apiKey: "" });
    expect(request.body.response_format).toBeUndefined();
    expect(request.headers.Authorization).toBeUndefined();
  });

  it("reads string content and finish reason", () => {
    const reply = openaiChat.parse({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: "length" }]
    });
    expect(reply).toEqual({ text: '{"a":1}', stopReason: "length", rawStopReason: "length" });
  });

  it("joins content parts when a gateway returns an array", () => {
    const reply = openaiChat.parse({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: '{"a":' },
              { type: "text", text: "1}" }
            ]
          }
        }
      ]
    });
    expect(reply.text).toBe('{"a":1}');
  });

  it("throws a shape error when there is no content", () => {
    expect(() => openaiChat.parse({ choices: [] })).toThrowError(
      expect.objectContaining({ kind: "shape" })
    );
    expect(() =>
      openaiChat.parse({ choices: [{ message: { content: [{ type: "image" }] } }] })
    ).toThrowError(expect.objectContaining({ kind: "shape" }));
  });
});

describe("protocol: openai-responses", () => {
  it("appends the responses path", () => {
    expect(openaiResponses.resolveUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses"
    );
  });

  it("puts the system prompt in instructions and passes messages as input", () => {
    const request = openaiResponses.build(input);
    expect(request.body).toMatchObject({
      model: "test-model",
      instructions: "system prompt",
      input: [{ role: "user", content: "user content" }],
      max_output_tokens: 4096,
      store: false,
      text: { format: { type: "json_object" } }
    });
  });

  it("moves system into instructions and keeps the rest of the conversation", () => {
    const request = openaiResponses.build(conversation);
    expect(request.body.instructions).toBe("system prompt");
    expect(request.body.input).toEqual([
      { role: "user", content: "第 1 段证据" },
      { role: "assistant", content: '{"segments":[]}' },
      { role: "user", content: "第 2 段证据" }
    ]);
  });

  it("reads the message item output", () => {
    const reply = openaiResponses.parse({
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [
            { type: "output_text", text: '{"a":' },
            { type: "output_text", text: "1}" }
          ]
        }
      ]
    });
    expect(reply.text).toBe('{"a":1}');
    expect(reply.stopReason).toBe("stop");
  });

  it("treats an incomplete max-output answer as truncated", () => {
    const reply = openaiResponses.parse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }]
    });
    expect(reply.stopReason).toBe("length");
  });

  it("falls back to a top-level output_text string", () => {
    expect(openaiResponses.parse({ output_text: "hello" }).text).toBe("hello");
  });
});

describe("protocol: anthropic", () => {
  it("adds the version prefix only once", () => {
    expect(anthropic.resolveUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    expect(anthropic.resolveUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    expect(anthropic.resolveUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    expect(anthropic.resolveUrl("https://proxy.example.com/anthropic")).toBe(
      "https://proxy.example.com/anthropic/v1/messages"
    );
  });

  it("sends api key headers and a top-level system prompt", () => {
    const request = anthropic.build(input);
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    });
    expect(request.body).toMatchObject({
      model: "test-model",
      system: "system prompt",
      max_tokens: 4096
    });
    expect(request.body.response_format).toBeUndefined();
  });

  it("puts a cache breakpoint on the last user message so the whole prefix gets cached", () => {
    const request = anthropic.build(conversation);
    expect(request.body.system).toBe("system prompt");
    expect(request.body.messages).toEqual([
      { role: "user", content: "第 1 段证据" },
      { role: "assistant", content: '{"segments":[]}' },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "第 2 段证据",
            cache_control: { type: "ephemeral" }
          }
        ]
      }
    ]);
  });

  it("reads text blocks and maps stop reasons", () => {
    const reply = anthropic.parse({
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: '{"a":1}' }
      ],
      stop_reason: "max_tokens"
    });
    expect(reply.text).toBe('{"a":1}');
    expect(reply.stopReason).toBe("length");
    expect(reply.rawStopReason).toBe("max_tokens");
  });

  it("throws a shape error when no text block exists", () => {
    expect(() => anthropic.parse({ content: [] })).toThrowError(
      expect.objectContaining({ kind: "shape" })
    );
  });
});

describe("protocol registry", () => {
  it("looks up adapters by id", () => {
    expect(protocolById("anthropic")).toBe(anthropic);
    expect(protocolById("openai-chat")).toBe(openaiChat);
  });

  it("detects a protocol from a complete endpoint path", () => {
    expect(detectProtocolFromUrl("https://x/v1/chat/completions")).toBe("openai-chat");
    expect(detectProtocolFromUrl("https://x/v1/responses")).toBe("openai-responses");
    expect(detectProtocolFromUrl("https://x/v1/messages")).toBe("anthropic");
    expect(detectProtocolFromUrl("https://x/v1")).toBeUndefined();
  });
});
