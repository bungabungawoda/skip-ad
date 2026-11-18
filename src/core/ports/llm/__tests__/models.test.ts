import { describe, expect, it } from "vitest";
import { pickModel, readModelList } from "../models";

const entry = (id: string, created?: number): { id: string; created?: number } =>
  created === undefined ? { id } : { id, created };

describe("model resolution", () => {
  it("prefers a cheap tier even when a pricier model is newer", () => {
    const picked = pickModel(
      [entry("gpt-4o", 200), entry("gpt-4o-mini", 100)],
      "fallback-model"
    );
    expect(picked).toBe("gpt-4o-mini");
  });

  it("takes the newest inside the same tier", () => {
    const picked = pickModel(
      [entry("deepseek-chat", 100), entry("deepseek-chat-v3", 300), entry("deepseek-chat-v2", 200)],
      "fallback-model"
    );
    expect(picked).toBe("deepseek-chat-v3");
  });

  it("drops embeddings, speech, image and moderation models", () => {
    const picked = pickModel(
      [
        entry("text-embedding-3-small", 900),
        entry("whisper-1", 900),
        entry("gpt-image-1", 900),
        entry("omni-moderation-latest", 900),
        entry("gpt-4o", 100)
      ],
      "fallback-model"
    );
    expect(picked).toBe("gpt-4o");
  });

  it("drops reasoning-only models", () => {
    const picked = pickModel(
      [
        entry("o1", 900),
        entry("o3-mini", 900),
        entry("openai/o1-mini", 900),
        entry("deepseek-reasoner", 900),
        entry("gpt-4o-mini", 100)
      ],
      "fallback-model"
    );
    expect(picked).toBe("gpt-4o-mini");
  });

  it("falls back when every model is filtered out", () => {
    expect(pickModel([entry("text-embedding-3-large")], "deepseek-chat")).toBe("deepseek-chat");
    expect(pickModel([], "deepseek-chat")).toBe("deepseek-chat");
  });

  it("is deterministic when creation times are missing", () => {
    const ids = [entry("b-model"), entry("a-model")];
    expect(pickModel(ids, "fallback")).toBe(pickModel([...ids].reverse(), "fallback"));
    expect(pickModel(ids, "fallback")).toBe("a-model");
  });

  it("reads the openai model list shape", () => {
    expect(
      readModelList({ data: [{ id: "a", created: 1 }, { id: "b" }, { id: 3 }] })
    ).toEqual([{ id: "a", created: 1 }, { id: "b" }]);
    expect(readModelList({})).toBeUndefined();
    expect(readModelList({ data: "nope" })).toBeUndefined();
  });
});
