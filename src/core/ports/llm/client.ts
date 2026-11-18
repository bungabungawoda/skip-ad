/**
 * LLM 客户端：把一次「要一段 JSON」变成一次或多次 HTTP 请求。
 *
 * 这一层负责三件事，协议细节交给适配器：
 * - 拼请求、带鉴权、按协议解正文；
 * - 把超时、限流、鉴权失败与形状错误分开，决定要不要重试；
 * - 所有重试都在这里完成，上层拿到正文或错误，不再自己重发。
 */

import type { LlmMessage } from "./types";
import type { ResolvedConnection } from "./config";
import {
  LlmError,
  ReplyShapeError,
  isOutputExhaustedError
} from "./errors";
import { protocolById } from "./protocols";
import { classifyHttpStatus, retryAfterMs } from "../http-status";
import type { FetchLike } from "../../lib/http";
import { errorText } from "../../lib/error";
import { logInfo } from "../../lib/log";
import {
  classifyThrown,
  defaultSleep,
  readErrorDetail,
  retryDelayMs,
  remainingRetryWaitMs,
  shouldRetryTimeout,
  shouldRetry,
  sleepUnlessAborted,
  type RequestLabels
} from "./request-control";

export { LlmError } from "./errors";
export type { LlmErrorKind } from "./errors";

export interface LlmClient {
  complete(
    messages: LlmMessage[],
    options?: { signal?: AbortSignal; videoDurationMs?: number }
  ): Promise<string>;
}

interface LlmClientDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单次请求超时；超时重试时自动翻倍。 */
  timeoutMs?: number;
  /** 连接探测只要一次结论，不要重试。 */
  retry?: boolean;
  /** 当前视频时长（毫秒），长视频按它放宽限流重试次数。 */
  videoDurationMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;
const MAX_OUTPUT_TOKENS = 4096;
const TEMPERATURE = 0.1;

const LLM_LABELS: RequestLabels = {
  cancelled: "LLM 请求已取消",
  timeout: "LLM 请求超时",
  network: "LLM 网络错误"
};
interface AttemptInput {
  connection: ResolvedConnection;
  messages: LlmMessage[];
  timeoutMs: number;
  /** 本次请求的输出上限；截断后翻倍重发时传入更大的值。 */
  maxOutputTokens: number;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}

type AttemptOutcome =
  | { ok: true; text: string; stopReason: string }
  | { ok: false; error: LlmError; retryAfter?: number };

async function attempt(input: AttemptInput): Promise<AttemptOutcome> {
  const { connection } = input;
  // 必须取成局部变量再调用：原生 fetch 被当作对象方法调用时 this 会变成
  // input，Service Worker 里直接抛 "Illegal invocation"（测试用 mock 函数
  // 不校验 this，所以只有真实环境才会暴露）。
  const fetchImpl = input.fetchImpl;
  const adapter = protocolById(connection.protocol);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  // 传入时已经中止：addEventListener 不会再触发，必须自己补一次。
  if (input.signal?.aborted) controller.abort();

  try {
    const request = adapter.build({
      baseUrl: connection.baseUrl,
      model: connection.model,
      apiKey: connection.apiKey,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      temperature: TEMPERATURE,
      jsonObject: connection.jsonObject
    });
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response, "读取 LLM 错误响应体失败");
      const truncated = detail.slice(0, 300);
      // 推理模型的「输出全花在思考上」常被代理报成 5xx；它不是普通服务端错误，
      // 原样重发只会再次撞上同一个输出上限。
      const kind = isOutputExhaustedError(detail)
        ? "truncated"
        : classifyHttpStatus(response.status, truncated);
      return {
        ok: false,
        error: new LlmError(
          `LLM 请求失败（${response.status}）${truncated ? `：${truncated}` : ""}`,
          kind,
          response.status
        ),
        retryAfter: retryAfterMs(response)
      };
    }
    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new ReplyShapeError(`响应不是合法 JSON：${errorText(error)}`);
    }
    const reply = adapter.parse(payload);
    return { ok: true, text: reply.text, stopReason: reply.stopReason };
  } catch (error) {
    return {
      ok: false,
      error: classifyThrown(error, timedOut, input.signal, LLM_LABELS)
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}

interface RunInput extends AttemptInput {
  sleep: (ms: number) => Promise<void>;
  retry: boolean;
  videoDurationMs?: number;
}

async function runWithRetry(input: RunInput): Promise<string> {
  let timeoutMs = input.timeoutMs;
  let maxOutputTokens = input.maxOutputTokens;
  // 截断只放大一次上限：两次都不够说明这张表远超模型输出能力，
  // 继续翻倍只会更慢更贵，交给上层报专门警告。
  let expanded = false;
  let waitedMs = 0;
  let timeoutAttempts = 0;
  for (let index = 0; ; index += 1) {
    const outcome = await attempt({ ...input, timeoutMs, maxOutputTokens });
    if (outcome.ok) {
      if (outcome.stopReason === "length") {
        if (!expanded) {
          expanded = true;
          maxOutputTokens *= 2;
          continue;
        }
        throw new LlmError(
          `模型回复达到输出上限（${maxOutputTokens} tokens），内容被截断`,
          "truncated"
        );
      }
      return outcome.text;
    }
    if (outcome.error.kind === "truncated") {
      if (!expanded) {
        expanded = true;
        logInfo("模型输出额度被推理耗尽，扩大上限后重试", {
          from: maxOutputTokens,
          to: maxOutputTokens * 2,
          status: outcome.error.status
        });
        maxOutputTokens *= 2;
        continue;
      }
      throw outcome.error;
    }
    if (!input.retry || !shouldRetry(outcome.error.kind)) {
      throw outcome.error;
    }
    if (outcome.error.kind === "timeout") {
      if (!shouldRetryTimeout(timeoutAttempts)) throw outcome.error;
      timeoutAttempts += 1;
      timeoutMs *= 2;
      continue;
    }
    const delay = retryDelayMs(outcome.retryAfter, RETRY_DELAY_MS);
    const remaining = remainingRetryWaitMs(waitedMs, input.videoDurationMs);
    if (delay > remaining) throw outcome.error;
    waitedMs += delay;
    logInfo("LLM 请求失败，准备重试", {
      kind: outcome.error.kind,
      status: outcome.error.status,
      attempt: index + 1,
      inMs: delay,
      waitedMs,
      budgetMs: remaining + delay
    });
    await sleepUnlessAborted(delay, input.signal, input.sleep, LLM_LABELS.cancelled);
  }
}

export function createLlmClient(
  connection: ResolvedConnection,
  deps: LlmClientDeps = {}
): LlmClient {
  const base: Omit<RunInput, "messages"> = {
    connection,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? defaultSleep,
    retry: deps.retry !== false,
    ...(deps.videoDurationMs !== undefined ? { videoDurationMs: deps.videoDurationMs } : {})
  };

  return {
    complete(messages, options) {
      return runWithRetry({
        ...base,
        messages,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.videoDurationMs !== undefined
          ? { videoDurationMs: options.videoDurationMs }
          : {})
      });
    }
  };
}
