import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECISION_MODEL,
  decisionReady,
  normalizeDecisionConfig,
  readDecisionConfig,
  writeDecisionConfig
} from "../config";
import { createMemoryStorageArea } from "../../../../../tests/helpers/memory-storage";

describe("决策模型配置", () => {
  it("默认不启用决策模型", () => {
    expect(normalizeDecisionConfig(undefined)).toEqual({
      endpoint: "",
      apiKey: "",
      model: DEFAULT_DECISION_MODEL,
      preferLlm: false
    });
    expect(decisionReady(normalizeDecisionConfig(undefined))).toBe(false);
  });

  it("新配置原样读取完整接口地址", async () => {
    const area = createMemoryStorageArea();
    await area.set({
      decision: {
        endpoint: "https://gateway.example.com/v1/decisions",
        apiKey: "key-1",
        model: "custom-decision"
      }
    });
    await expect(readDecisionConfig(area)).resolves.toEqual({
      endpoint: "https://gateway.example.com/v1/decisions",
      apiKey: "key-1",
      model: "custom-decision",
      preferLlm: false
    });
  });

  it("没有 Key 也算配置完成，本地网关可以直接用", () => {
    expect(
      decisionReady({
        endpoint: "http://127.0.0.1:3425/v1/decisions",
        apiKey: "",
        model: "local-decision",
        preferLlm: false
      })
    ).toBe(true);
  });

  it("用户选择 LLM 优先时保留这个偏好", async () => {
    const area = createMemoryStorageArea();
    await area.set({
      decision: {
        endpoint: "https://gateway.example.com/v1/decisions",
        apiKey: "key-1",
        model: "custom-decision",
        preferLlm: true
      }
    });
    await expect(readDecisionConfig(area)).resolves.toMatchObject({ preferLlm: true });
    const written = await writeDecisionConfig(area, { apiKey: "key-2" });
    expect(written.preferLlm).toBe(true);
  });

  it("地址不合法时归一成未配置", () => {
    expect(
      normalizeDecisionConfig({
        endpoint: "http://example.com/v1/decisions",
        model: "x"
      }).endpoint
    ).toBe("");
  });
});
