/**
 * LLM 客户端与决策接口客户端共用的请求控制：错误分类、退避等待、重试判定。
 *
 * 两家接口的请求体和响应形状完全不同，但「什么算取消、什么算超时、什么值得重试」
 * 是同一套规则。机制放这里，各自的文案留在各自客户端。
 */

import { LlmError, type LlmErrorKind } from "./errors";
import { errorText } from "../../lib/error";
import { logWarn } from "../../lib/log";
import { isRetryableRequestFailure } from "../../failure-kind";
import {
  sleep as defaultSleep,
  sleepUnlessAborted as sleepWithSignal
} from "../../lib/async";

export { defaultSleep };

export interface RequestLabels {
  cancelled: string;
  timeout: string;
  network: string;
}

/** 累计等待预算下限：短片或未知时长也给 2 分钟。 */
const MIN_RETRY_BUDGET_MS = 2 * 60_000;
/** 超时不睡觉，只翻倍请求超时；这种重试单独限两次，避免无限翻倍。 */
const MAX_TIMEOUT_ATTEMPTS = 2;

export function classifyThrown(
  error: unknown,
  timedOut: boolean,
  signal: AbortSignal | undefined,
  labels: RequestLabels
): LlmError {
  if (error instanceof LlmError) return error;
  if (signal?.aborted && !timedOut) return new LlmError(labels.cancelled, "cancelled");
  if (timedOut || (error instanceof Error && error.name === "AbortError")) {
    return new LlmError(labels.timeout, "timeout");
  }
  return new LlmError(errorText(error, labels.network), "network");
}

/** 退避等待期间取消要立刻生效：否则服务端给一个很大的 Retry-After，取消后请求还挂着。 */
export function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
  cancelMessage: string
): Promise<void> {
  return sleepWithSignal(ms, signal, {
    sleep,
    onAbort: () => new LlmError(cancelMessage, "cancelled")
  });
}

/** 累计等待预算：max(2 分钟, 视频时长的一半)。视频越长，越等得起。 */
export function retryBudgetMs(durationMs: number | undefined): number {
  const half = durationMs && Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 2 : 0;
  return Math.max(MIN_RETRY_BUDGET_MS, half);
}

/** 这次失败后还能等多久；返回 0 表示预算用尽，不再重试。 */
export function remainingRetryWaitMs(waitedMs: number, durationMs?: number): number {
  return Math.max(0, retryBudgetMs(durationMs) - waitedMs);
}

/** 所有请求共用一套重试口径：只看错误类别，次数由累计等待预算控制。 */
export function shouldRetry(kind: LlmErrorKind): boolean {
  return isRetryableRequestFailure(kind);
}

/** 超时重试按次数限制；其余失败按累计等待预算限制。 */
export function shouldRetryTimeout(timeoutAttempts: number): boolean {
  return timeoutAttempts < MAX_TIMEOUT_ATTEMPTS - 1;
}

/** 服务端建议等待优先；没有建议时用本地退避，预算由调用方按累计等待控制。 */
export function retryDelayMs(retryAfter: number | undefined, defaultMs: number): number {
  return retryAfter ?? defaultMs;
}

/** 读失败响应正文；读不出来只留日志，正文按空字符串处理。 */
export async function readErrorDetail(response: Response, scope: string): Promise<string> {
  return response.text().catch((error: unknown) => {
    logWarn(scope, errorText(error));
    return "";
  });
}
