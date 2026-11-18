import { describe, expect, it } from "vitest";
import { humanError } from "../connection-errors";

describe("连接失败的人话", () => {
  it("认识的错误类别给出具体建议", () => {
    expect(humanError({ kind: "auth" })).toContain("Key");
    expect(humanError({ kind: "path_not_found" })).toContain("地址不对");
    expect(humanError({ kind: "rate_limit" })).toContain("限流");
  });

  it("没有类别或类别不认识时按网络问题兜底", () => {
    expect(humanError(new Error("boom"))).toContain("连不上");
    expect(humanError({ kind: "made-up" })).toBe("连接失败");
    expect(humanError(null)).toContain("连不上");
  });
});
