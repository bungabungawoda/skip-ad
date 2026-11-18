import { describe, expect, it } from "vitest";
import { effectivePromptVersion } from "../prompt-version";

describe("effectivePromptVersion", () => {
  it("没有类型改写时返回基础版本", () => {
    expect(effectivePromptVersion("v1")).toBe("v1");
    expect(effectivePromptVersion("v1", { sponsor: "  " })).toBe("v1");
  });

  it("有改写时稳定地追加哈希后缀，且不同改写互不相同", () => {
    const first = effectivePromptVersion("v1", { sponsor: "用户定义" });
    const second = effectivePromptVersion("v1", { sponsor: "用户定义" });
    expect(first).toBe(second);
    expect(first).toMatch(/^v1:[0-9a-f]{8}$/);
    expect(first).not.toBe(effectivePromptVersion("v1"));
    expect(first).not.toBe(effectivePromptVersion("v1", { sponsor: "另一种定义" }));
  });

  it("改写文本前后的空白被忽略，对象键顺序不影响缓存键", () => {
    expect(effectivePromptVersion("v1", { sponsor: "  用户定义  ", insert: "露出" })).toBe(
      effectivePromptVersion("v1", { insert: "露出", sponsor: "用户定义" })
    );
  });

  it("只有一个字符的改写也要换缓存键", () => {
    expect(effectivePromptVersion("v1", { sponsor: "x" })).not.toBe("v1");
  });

  it("同一段描述换到别的类型上必须换缓存键", () => {
    expect(effectivePromptVersion("v1", { sponsor: "露出" })).not.toBe(
      effectivePromptVersion("v1", { insert: "露出" })
    );
  });
});
