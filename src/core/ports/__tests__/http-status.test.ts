import { describe, expect, it } from "vitest";
import { retryAfterFromDetail } from "../http-status";

describe("从错误正文读退避时间", () => {
  it("认 Gemini 的 Please retry in 37s", () => {
    expect(
      retryAfterFromDetail(
        "Rate limit exceeded for model gemini-decision-1. Please retry in 37s or upgrade your tier."
      )
    ).toBe(37_000);
  });

  it("认 retryDelay 字段与秒/seconds 写法", () => {
    expect(retryAfterFromDetail('{"retryDelay":"12s"}')).toBe(12_000);
    expect(retryAfterFromDetail("retry after 5 seconds")).toBe(5_000);
  });

  it("没有秒数的正文不猜等待时间", () => {
    expect(retryAfterFromDetail("retry 3 times")).toBeUndefined();
    expect(retryAfterFromDetail("overloaded")).toBeUndefined();
  });
});
