import { describe, expect, it } from "vitest";
import { CUSTOM_PROVIDER_ID } from "../../../core/ports/llm/config";
import {
  connectionDraftReducer,
  draftActionForField,
  initialConnectionDraft,
  resolveConnectionTarget,
  type ConnectionDraft,
  type ConnectionDraftAction
} from "../connection-draft";

function reduce(
  state: ConnectionDraft,
  ...actions: ConnectionDraftAction[]
): ConnectionDraft {
  return actions.reduce(connectionDraftReducer, state);
}

describe("connection draft", () => {
  it("starts with DeepSeek and its default address", () => {
    expect(initialConnectionDraft()).toMatchObject({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      addressError: null,
      lastOrigin: "https://api.deepseek.com"
    });
  });

  it("fills the selected provider's address and clears the old key", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-key", value: "sk-test" },
      { type: "choose-provider", id: "openai" }
    );
    expect(state).toMatchObject({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      lastOrigin: "https://api.openai.com"
    });
  });

  it("recognizes a known address without rewriting text while typing", () => {
    const state = reduce(initialConnectionDraft(), {
      type: "input-address",
      value: "https://api.openai.com/v1/chat/completions"
    });
    expect(state).toMatchObject({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1/chat/completions"
    });
  });

  it("keeps the key when only the path changes on the same origin", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "https://api.openai.com/v1" },
      { type: "input-key", value: "sk-test" },
      { type: "input-address", value: "https://api.openai.com/v1/chat/completions" }
    );
    expect(state.apiKey).toBe("sk-test");
  });

  it("switches to custom for an unknown address and keeps a reusable draft", () => {
    const state = reduce(initialConnectionDraft(), {
      type: "input-address",
      value: "https://gateway.example.com/v1"
    });
    expect(state).toMatchObject({
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl: "https://gateway.example.com/v1",
      customBaseUrl: "https://gateway.example.com/v1"
    });
  });

  it("restores the last custom address after switching providers", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "https://gateway.example.com/v1" },
      { type: "choose-provider", id: "deepseek" },
      { type: "choose-provider", id: CUSTOM_PROVIDER_ID }
    );
    expect(state.baseUrl).toBe("https://gateway.example.com/v1");
  });

  it("canonicalizes a known address on commit", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "https://api.openai.com/v1/chat/completions" },
      { type: "commit-address" }
    );
    expect(state.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("refills an empty preset address and rejects an empty custom address", () => {
    const preset = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "" },
      { type: "commit-address" }
    );
    expect(preset.baseUrl).toBe("https://api.deepseek.com");

    const custom = reduce(
      initialConnectionDraft(),
      { type: "choose-provider", id: CUSTOM_PROVIDER_ID },
      { type: "commit-address" }
    );
    expect(custom.addressError).toBe("请填写端点地址。");
  });

  it("auto-completes a scheme-less known address", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "api.deepseek.com" },
      { type: "commit-address" }
    );
    expect(state).toMatchObject({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      addressError: null
    });
  });

  it("auto-completes a scheme-less custom address on commit", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "gateway.example.com/v1" },
      { type: "commit-address" }
    );
    expect(state).toMatchObject({
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl: "https://gateway.example.com/v1",
      customBaseUrl: "https://gateway.example.com/v1",
      addressError: null
    });
  });

  it("shows an inline error for an invalid non-empty address", () => {
    const state = reduce(
      initialConnectionDraft(),
      { type: "input-address", value: "ftp://example.com/v1" },
      { type: "commit-address" }
    );
    expect(state.addressError).toContain("https://");
  });

  it("resolves a preset, a custom endpoint, and invalid input", () => {
    expect(
      resolveConnectionTarget(
        reduce(initialConnectionDraft(), {
          type: "input-address",
          value: "https://api.openai.com/v1/chat/completions"
        })
      )
    ).toEqual({
      kind: "ready",
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1"
    });

    expect(
      resolveConnectionTarget(
        reduce(initialConnectionDraft(), {
          type: "input-address",
          value: "https://gateway.example.com/v1"
        })
      )
    ).toEqual({
      kind: "ready",
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl: "https://gateway.example.com/v1"
    });

    expect(
      resolveConnectionTarget(
        reduce(initialConnectionDraft(), {
          type: "input-address",
          value: "ftp://example.com/v1"
        })
      )
    ).toMatchObject({ kind: "error" });
  });

  it("restores saved custom draft and maps form fields to actions", () => {
    const restored = reduce(initialConnectionDraft(), {
      type: "restore-custom",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "qwen2.5:7b"
    });
    expect(restored).toMatchObject({
      customBaseUrl: "http://127.0.0.1:3425/v1",
      model: "qwen2.5:7b"
    });
    expect(draftActionForField("apiKey", "sk-test")).toEqual({
      type: "input-key",
      value: "sk-test"
    });
    expect(draftActionForField("baseUrl", "https://api.openai.com/v1")).toEqual({
      type: "input-address",
      value: "https://api.openai.com/v1"
    });
    expect(draftActionForField("model", "gpt-4o-mini")).toEqual({
      type: "input-model",
      value: "gpt-4o-mini"
    });
  });
});
