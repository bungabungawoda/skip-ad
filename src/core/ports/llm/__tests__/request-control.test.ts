import { describe, expect, it } from "vitest";
import {
  remainingRetryWaitMs,
  retryBudgetMs,
  retryDelayMs,
  shouldRetry,
  shouldRetryTimeout
} from "../request-control";

describe("按累计等待时间决定重试预算", () => {
  it("预算是 max(2 分钟, 视频时长的一半)", () => {
    expect(retryBudgetMs(undefined)).toBe(2 * 60_000);
    expect(retryBudgetMs(60_000)).toBe(2 * 60_000);
    expect(retryBudgetMs(10 * 60_000)).toBe(5 * 60_000);
    expect(retryBudgetMs(6.5 * 60 * 60_000)).toBe(3.25 * 60 * 60_000);
  });

  it("预算随已等待时间递减，用尽后返回 0", () => {
    expect(remainingRetryWaitMs(60_000, 60_000)).toBe(60_000);
    expect(remainingRetryWaitMs(2 * 60_000, 60_000)).toBe(0);
    expect(remainingRetryWaitMs(10 * 60_000, 10 * 60_000)).toBe(0);
  });

  it("只放宽可重试的错误，认证失败不重试", () => {
    expect(shouldRetry("rate_limit")).toBe(true);
    expect(shouldRetry("auth")).toBe(false);
  });

  it("超时单独限两次，不占用等待预算", () => {
    expect(shouldRetryTimeout(0)).toBe(true);
    expect(shouldRetryTimeout(1)).toBe(false);
  });

  it("服务端建议的等待时间照做", () => {
    expect(retryDelayMs(37_000, 1_000)).toBe(37_000);
    expect(retryDelayMs(30 * 60_000, 1_000)).toBe(30 * 60_000);
    expect(retryDelayMs(undefined, 1_000)).toBe(1_000);
  });
});
