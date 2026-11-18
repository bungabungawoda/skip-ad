import { describe, expect, it, vi } from "vitest";
import {
  clearActiveConnection,
  describeLlmConfig,
  entryFor,
  readAnalysisPolicy,
  readLlmConfig,
  saveConnection,
  writeAnalysisPolicy
} from "../settings";
import { DEFAULT_POLICY } from "../../policy/policy";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";

function area(initial: Record<string, unknown> = {}) {
  const storage = createMemoryStorageArea();
  for (const [key, value] of Object.entries(initial)) storage.data.set(key, value);
  return storage;
}

const deepseekEntry = {
  model: "deepseek-chat",
  apiKey: "sk-test",
  jsonObject: true,
  connectedAt: 1
};

describe("settings", () => {
  it("并发保存两家服务商时不会互相覆盖", async () => {
    const storage = area();
    // 不加串行化时，两边都读到旧配置，后写的会把先写的那家丢掉。
    await Promise.all([
      saveConnection(storage, "deepseek", deepseekEntry),
      saveConnection(storage, "moonshot", { ...deepseekEntry, model: "kimi" })
    ]);
    const config = await readLlmConfig(storage);
    expect(Object.keys(config?.byProvider ?? {}).sort()).toEqual(["deepseek", "moonshot"]);
    expect(config?.byProvider.moonshot?.model).toBe("kimi");
  });

  it("returns defaults when nothing is stored", async () => {
    const storage = area();
    await expect(readAnalysisPolicy(storage)).resolves.toEqual(DEFAULT_POLICY);
    await expect(readLlmConfig(storage)).resolves.toBeUndefined();
  });

  it("ignores a legacy stored config", async () => {
    const storage = area({
      llm: {
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-chat",
        apiKey: "sk-test"
      }
    });
    await expect(readLlmConfig(storage)).resolves.toBeUndefined();
  });

  it("writes a normalized policy", async () => {
    const storage = area();
    const written = await writeAnalysisPolicy(storage, { confidenceThreshold: 2 });
    expect(written.confidenceThreshold).toBe(1);
    await expect(readAnalysisPolicy(storage)).resolves.toEqual(written);
  });

  it("保存类型策略只合并补丁里的字段", async () => {
    const storage = area();
    await writeAnalysisPolicy(storage, { kindPromptOverrides: { sponsor: "口播带货" } });
    const written = await writeAnalysisPolicy(storage, { perKind: { sponsor: "mark" } });
    expect(written.kindPromptOverrides).toEqual({ sponsor: "口播带货" });
    expect(written.perKind.sponsor).toBe("mark");
  });

  it("并发写策略时按顺序落盘，最终保留最后一次", async () => {
    const storage = area();
    const firstWrite = deferred<void>();
    const firstStarted = deferred<void>();
    const set = vi.fn(async (items: Record<string, unknown>) => {
      const call = set.mock.calls.length;
      if (call === 1) {
        firstStarted.resolve();
        await firstWrite.promise;
      }
      for (const [key, value] of Object.entries(items)) storage.data.set(key, value);
    });
    const areaWithQueue = { ...storage, set };
    const first = writeAnalysisPolicy(areaWithQueue, { confidenceThreshold: 0.5 });
    const second = writeAnalysisPolicy(areaWithQueue, { confidenceThreshold: 0.7 });
    await firstStarted.promise;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(set).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await first;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(set).toHaveBeenCalledTimes(2);
    await Promise.all([first, second]);
    expect(await readAnalysisPolicy(storage)).toMatchObject({ confidenceThreshold: 0.7 });
  });

  it("keeps each provider's entry when switching", async () => {
    const storage = area();
    await saveConnection(storage, "deepseek", deepseekEntry);
    await saveConnection(storage, "moonshot", {
      model: "moonshot-v1-8k",
      apiKey: "sk-moon",
      jsonObject: true,
      connectedAt: 2
    });
    const config = await readLlmConfig(storage);
    expect(config?.active).toBe("moonshot");
    expect(entryFor(config, "deepseek")).toMatchObject({ model: "deepseek-chat" });
    expect(entryFor(config, "moonshot")).toMatchObject({ apiKey: "sk-moon" });
  });

  it("drops the whole key once the last connection is removed", async () => {
    const storage = area();
    await saveConnection(storage, "deepseek", deepseekEntry);
    await expect(clearActiveConnection(storage)).resolves.toBeUndefined();
    expect(storage.data.has("llm")).toBe(false);
  });

  it("switches to a remaining provider after disconnecting", async () => {
    const storage = area();
    await saveConnection(storage, "deepseek", deepseekEntry);
    await saveConnection(storage, "moonshot", {
      model: "moonshot-v1-8k",
      apiKey: "sk-moon",
      jsonObject: true,
      connectedAt: 2
    });
    const remaining = await clearActiveConnection(storage);
    expect(remaining?.active).toBe("deepseek");
  });

  it("describes what the popup should show", () => {
    expect(describeLlmConfig(undefined)).toEqual({ configured: false });
    expect(
      describeLlmConfig({
        active: "deepseek",
        byProvider: { deepseek: deepseekEntry }
      })
    ).toEqual({
      configured: true,
      providerId: "deepseek",
      providerLabel: "DeepSeek",
      model: "deepseek-chat",
      endpointOrigin: "https://api.deepseek.com"
    });
  });

  it("labels a custom connection instead of a preset", () => {
    expect(
      describeLlmConfig({
        active: "custom",
        byProvider: {
          custom: {
            ...deepseekEntry,
            baseUrl: "https://gateway.example.com/v1",
            protocol: "openai-chat"
          }
        }
      })
    ).toMatchObject({
      providerLabel: "自定义端点",
      endpointOrigin: "https://gateway.example.com"
    });
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
