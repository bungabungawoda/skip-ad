import { describe, expect, it } from "vitest";
import { toUiError } from "../analysis-policy";
import { LlmError } from "../../ports/llm/client";
import { RuntimeError } from "../../ports/runtime-client";

describe("分析失败转成界面错误", () => {
  it("保留 LLM 与后台错误的类别", () => {
    expect(toUiError(new LlmError("限流", "rate_limit"), 0).kind).toBe("rate_limit");
    expect(toUiError(new RuntimeError("后台断开", "disconnected"), 0).kind).toBe("disconnected");
  });

  it("未知异常按网络失败处理", () => {
    expect(toUiError(new Error("boom"), 0).kind).toBe("network");
  });

  it("带上状态码与耗时", () => {
    expect(toUiError(new LlmError("服务端错误", "server", 503), 1_234)).toMatchObject({
      kind: "server",
      status: 503,
      elapsedMs: 1_234,
      newSegments: 0
    });
  });
});
