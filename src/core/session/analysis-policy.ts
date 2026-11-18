/** 分析失败怎么分类、怎么转成界面错误；重试只发生在请求层，会话层不再重跑。 */
import { errorText } from "../lib/error";
import { LlmError } from "../ports/llm/client";
import { RuntimeError } from "../ports/runtime-client";
import type { UiErrorInfo } from "../ui/state";

/** 未知异常按网络失败处理；LlmError 与 RuntimeError 的 kind 直接透传。 */
function classifyRunError(error: unknown): string {
  if (error instanceof LlmError) return error.kind;
  if (error instanceof RuntimeError) return error.kind;
  return "network";
}

/** 把分析异常转成界面错误：来源是 LlmError.kind、status 和分析耗时。 */
export function toUiError(error: unknown, elapsedMs: number): UiErrorInfo {
  const info: UiErrorInfo = {
    kind: classifyRunError(error),
    message: errorText(error),
    elapsedMs,
    newSegments: 0
  };
  if (error instanceof LlmError && error.status !== undefined) {
    return { ...info, status: error.status };
  }
  return info;
}

