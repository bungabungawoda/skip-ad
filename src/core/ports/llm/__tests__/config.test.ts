import { describe, expect, it } from "vitest";
import {
  classifyProviderUrl,
  DEFAULT_PROVIDER_ID,
  LLM_PRESETS,
  normalizeLlmConfig,
  presetById,
  resolveConnection
} from "../config";

const deepseek = {
  model: "deepseek-chat",
  apiKey: "sk-test",
  jsonObject: true,
  connectedAt: 1_700_000_000_000
};

describe("LLM config", () => {
  it("normalizes a config", () => {
    const config = normalizeLlmConfig({
      active: "deepseek",
      byProvider: { deepseek }
    });
    expect(config).toEqual({
      active: "deepseek",
      byProvider: { deepseek }
    });
  });

  it("returns undefined when nothing is connected", () => {
    expect(normalizeLlmConfig(undefined)).toBeUndefined();
    expect(normalizeLlmConfig({})).toBeUndefined();
    expect(normalizeLlmConfig({ byProvider: {} })).toBeUndefined();
  });

  it("drops entries without a model name", () => {
    const config = normalizeLlmConfig({
      active: "deepseek",
      byProvider: { deepseek: { ...deepseek, model: "  " } }
    });
    expect(config).toBeUndefined();
  });

  it("falls back to the first provider when active points nowhere", () => {
    const config = normalizeLlmConfig({
      active: "kimi",
      byProvider: { deepseek }
    });
    expect(config?.active).toBe("deepseek");
  });

  it("accepts a loopback http gateway but rejects http elsewhere", () => {
    const good = normalizeLlmConfig({
      active: "custom",
      byProvider: {
        custom: {
          ...deepseek,
          baseUrl: "http://127.0.0.1:3425/v1",
          protocol: "openai-chat"
        }
      }
    });
    expect(good?.byProvider.custom?.baseUrl).toBe("http://127.0.0.1:3425/v1");

    for (const baseUrl of ["ftp://x", "http://192.168.1.5:8080/v1", "http://example.com/v1"]) {
      const bad = normalizeLlmConfig({
        active: "custom",
        byProvider: { custom: { ...deepseek, baseUrl } }
      });
      expect(bad).toBeUndefined();
    }
  });

  it("ignores a legacy flat config", () => {
    expect(
      normalizeLlmConfig({
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-chat"
      })
    ).toBeUndefined();
  });

  it("resolves a preset connection into request parameters", () => {
    const config = normalizeLlmConfig({
      active: "deepseek",
      byProvider: { deepseek }
    });
    const resolved = resolveConnection(config!);
    expect(resolved).toMatchObject({
      providerId: "deepseek",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: "sk-test",
      jsonObject: true
    });
  });

  it("resolves a custom connection with its own address and protocol", () => {
    const config = normalizeLlmConfig({
      active: "custom",
      byProvider: {
        custom: {
          model: "claude-3-5-sonnet",
          apiKey: "sk-x",
          jsonObject: false,
          connectedAt: 0,
          baseUrl: "https://proxy.example.com",
          protocol: "anthropic"
        }
      }
    });
    expect(resolveConnection(config!)).toMatchObject({
      providerId: "custom",
      protocol: "anthropic",
      baseUrl: "https://proxy.example.com"
    });
  });

  it("keeps the preset list addressable", () => {
    expect(LLM_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(DEFAULT_PROVIDER_ID).toBe("deepseek");
    expect(LLM_PRESETS[0]?.id).toBe("deepseek");
    expect(presetById("deepseek")?.protocol).toBe("openai-chat");
    expect(presetById("anthropic")?.protocol).toBe("anthropic");
    expect(presetById("nope")).toBeUndefined();
  });

  it("lists every domestic preset before the foreign ones", () => {
    const domestic = LLM_PRESETS.filter((preset) => preset.region === "domestic");
    const foreign = LLM_PRESETS.filter((preset) => preset.region === "foreign");
    expect(domestic.map((preset) => preset.id)).toEqual([
      "deepseek",
      "moonshot",
      "zhipu",
      "siliconflow"
    ]);
    expect(foreign.map((preset) => preset.id)).toEqual(["openai", "anthropic", "openrouter"]);
    expect(LLM_PRESETS.map((preset) => preset.region)).toEqual([
      "domestic",
      "domestic",
      "domestic",
      "domestic",
      "foreign",
      "foreign",
      "foreign"
    ]);
  });
});

describe("classifyProviderUrl", () => {
  it("matches a preset by origin and returns the canonical base address", () => {
    expect(classifyProviderUrl("https://api.deepseek.com/v1/chat/completions")).toMatchObject({
      kind: "preset",
      preset: { id: "deepseek" },
      baseUrl: "https://api.deepseek.com"
    });
    expect(classifyProviderUrl("https://api.openai.com/v1")).toMatchObject({
      kind: "preset",
      preset: { id: "openai" },
      baseUrl: "https://api.openai.com/v1"
    });
  });

  it("accepts a full endpoint path when its protocol matches the preset", () => {
    expect(classifyProviderUrl("https://api.anthropic.com/v1/messages")).toMatchObject({
      kind: "preset",
      preset: { id: "anthropic" },
      baseUrl: "https://api.anthropic.com"
    });
  });

  it("keeps a different protocol on a known host as a custom endpoint", () => {
    expect(classifyProviderUrl("https://api.openai.com/v1/responses")).toMatchObject({
      kind: "custom",
      baseUrl: "https://api.openai.com/v1/responses"
    });
  });

  it("keeps an unknown HTTP gateway as a custom endpoint", () => {
    expect(classifyProviderUrl("http://127.0.0.1:3425/v1")).toMatchObject({
      kind: "custom",
      baseUrl: "http://127.0.0.1:3425/v1"
    });
  });

  it("does not match lookalike hosts or non-default ports", () => {
    expect(classifyProviderUrl("https://api.deepseek.com.evil.example/v1")).toMatchObject({
      kind: "custom"
    });
    expect(classifyProviderUrl("https://api.deepseek.com:8443/v1")).toMatchObject({
      kind: "custom"
    });
  });

  it("rejects malformed and insecure non-loopback addresses", () => {
    expect(classifyProviderUrl("")).toEqual({ kind: "invalid" });
    expect(classifyProviderUrl("not-an-address")).toEqual({ kind: "invalid" });
    expect(classifyProviderUrl("http://api.deepseek.com")).toEqual({ kind: "invalid" });
  });

  it("auto-completes the scheme when the user omits it", () => {
    expect(classifyProviderUrl("api.openai.com/v1")).toMatchObject({
      kind: "preset",
      preset: { id: "openai" },
      baseUrl: "https://api.openai.com/v1"
    });
    expect(classifyProviderUrl("gateway.example.com/v1")).toEqual({
      kind: "custom",
      baseUrl: "https://gateway.example.com/v1"
    });
  });
});

describe("resolveConnection 的边界", () => {
  it("自定义端点缺地址时解析不出来", () => {
    expect(
      resolveConnection({
        active: "custom",
        byProvider: {
          custom: { model: "m", apiKey: "", jsonObject: false, connectedAt: 0 }
        }
      })
    ).toBeUndefined();
  });

  it("预设查不到时把当前条目当成自定义端点", () => {
    expect(
      resolveConnection({
        active: "unknown-provider",
        byProvider: {
          "unknown-provider": {
            model: "m",
            apiKey: "",
            jsonObject: false,
            connectedAt: 0,
            baseUrl: "https://x.example.com",
            protocol: "openai-responses"
          }
        }
      })
    ).toMatchObject({ protocol: "openai-responses", baseUrl: "https://x.example.com" });
  });
});
