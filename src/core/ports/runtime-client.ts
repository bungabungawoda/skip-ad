import type { LlmClient, LlmErrorKind } from "./llm/client";
import { LlmError } from "./llm/client";
import type { CacheEntry, CacheStore } from "./cache/store";
import type { LlmMessage } from "./llm/types";
import { errorText } from "../lib/error";
import { logWarn } from "../lib/log";
import { EMPTY_SKIP_TOTALS, type SkipTotals } from "../metrics/types";
import type { RuntimeRequest, RuntimeResponse, RuntimeSettings } from "./messages";
import type { DecisionClient, DecisionResult } from "./decision/types";
import type { DecisionConfig } from "./decision/config";
import { isForwardedErrorKind } from "../failure-kind";

export class RuntimeError extends Error {
  readonly kind: string;

  constructor(message: string, kind = "runtime") {
    super(message);
    this.name = "RuntimeError";
    this.kind = kind;
  }
}

/** 所有页面与内容脚本发往后台的唯一入口：统一处理断连、空响应和 ok:false。 */
export async function sendRuntime<T>(request: RuntimeRequest): Promise<T> {
  let response: RuntimeResponse<T> | undefined;
  // 只记录操作类型和缓存 key；绝不把 messages / config（含 Key）写进日志。
  const context = {
    type: request.type,
    ...("key" in request ? { key: request.key } : {})
  };
  try {
    response = (await chrome.runtime.sendMessage(request)) as
      | RuntimeResponse<T>
      | undefined;
  } catch (error) {
    logWarn("后台消息发送失败", { ...context, error: errorText(error) });
    throw new RuntimeError(errorText(error, "后台没有响应"), "disconnected");
  }
  if (!response) {
    logWarn("后台返回空结果", context);
    throw new RuntimeError("后台没有返回结果", "empty");
  }
  if (!response.ok) {
    // 一行文字写清是哪条消息、什么错误：对象在复制出来的日志里只会变成 [object Object]。
    logWarn(
      "后台返回业务错误",
      `${JSON.stringify(context)} · ${response.error.kind} · ${response.error.message}`
    );
    throw new RuntimeError(response.error.message, response.error.kind);
  }
  return response.value;
}

let requestSeq = 0;
/**
 * 每个内容脚本一份随机盐：后台的中止登记表是所有标签页共用的，
 * 只靠「毫秒时间戳 + 本标签页序号」会让两个标签页在同一毫秒撞 id，
 * 后到的请求把先到的掐掉，取消也会误杀别的标签页。
 */
const requestSalt = Math.random().toString(36).slice(2, 8);

function nextRequestId(): string {
  requestSeq += 1;
  return `llm-${requestSalt}-${Date.now().toString(36)}-${requestSeq}`;
}

interface AbortableSend {
  request: RuntimeRequest;
  requestId: string;
  abortType: "llm.abort" | "decision.abort";
  abortLogScope: string;
  signal?: AbortSignal;
}

/**
 * 代发一次可取消的后台请求：带上 requestId，取消时发一条 abort 消息让后台断掉 fetch。
 * LLM 与决策接口共用这套流程，只有请求体和 abort 消息类型不同。
 */
async function sendWithAbort<T>(options: AbortableSend): Promise<T> {
  const { signal, requestId, abortType, abortLogScope } = options;
  let settled = false;
  const onAbort = (): void => {
    if (settled) return;
    try {
      void chrome.runtime
        .sendMessage({ type: abortType, requestId })
        .catch((error: unknown) => logWarn(abortLogScope, errorText(error)));
    } catch (error) {
      // 扩展被重载时 runtime 可能同步抛错，取消流程不能因此中断。
      logWarn(abortLogScope, errorText(error));
    }
  };
  if (signal?.aborted) throw new LlmError("分析已取消", "cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await sendRuntime<T>(options.request);
  } catch (error) {
    if (error instanceof RuntimeError) {
      const kind: LlmErrorKind = isForwardedErrorKind(error.kind)
        ? (error.kind as LlmErrorKind)
        : "network";
      const llmError = new LlmError(error.message, kind);
      throw llmError;
    }
    throw error;
  } finally {
    settled = true;
    signal?.removeEventListener("abort", onAbort);
  }
}

async function proxyComplete(
  messages: LlmMessage[],
  options?: { signal?: AbortSignal; videoDurationMs?: number }
): Promise<string> {
  const requestId = nextRequestId();
  return sendWithAbort<string>({
    request: {
      type: "llm.complete",
      messages,
      requestId,
      ...(options?.videoDurationMs !== undefined
        ? { videoDurationMs: options.videoDurationMs }
        : {})
    },
    requestId,
    abortType: "llm.abort",
    abortLogScope: "发送取消请求失败",
    ...(options?.signal ? { signal: options.signal } : {})
  });
}

export function createRuntimeLlmClient(): LlmClient {
  return { complete: proxyComplete };
}

let decisionSeq = 0;

/**
 * 决策请求走后台：Key 只在 Service Worker 里读。
 * 中止沿用 llm.abort 那套 requestId 机制，取消分析时两条链一起断。
 */
export function createRuntimeDecisionClient(): DecisionClient {
  return {
    decide(request): Promise<DecisionResult> {
      const requestId = `decision-${requestSalt}-${Date.now().toString(36)}-${++decisionSeq}`;
      return sendWithAbort<DecisionResult>({
        request: {
          type: "decision.decide",
          input: request.input,
          questions: request.questions,
          requestId,
          ...(request.videoDurationMs !== undefined
            ? { videoDurationMs: request.videoDurationMs }
            : {})
        },
        requestId,
        abortType: "decision.abort",
        abortLogScope: "发送决策取消请求失败",
        ...(request.signal ? { signal: request.signal } : {})
      });
    }
  };
}

/**
 * 缓存调用统一降级：CacheStore 的契约是「不抛错」。
 * 代理层是唯一会因后台断连失败的地方，在这里兜一次，调用方直接信任结果。
 */
async function cacheCall<T>(
  operation: string,
  cacheKey: string | null,
  run: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logWarn(`缓存${operation}失败，已降级`, {
      ...(cacheKey ? { cacheKey } : {}),
      error: errorText(error)
    });
    return fallback;
  }
}

export function createRuntimeCache(): CacheStore {
  return {
    get: (key) =>
      cacheCall("读取", key, () => sendRuntime<CacheEntry | null>({ type: "cache.get", key }), null),
    set: (key, entry) =>
      cacheCall(
        "写入",
        key,
        async () => {
          await sendRuntime({ type: "cache.set", key, entry });
        },
        undefined
      ),
    delete: (key) =>
      cacheCall(
        "删除",
        key,
        () => sendRuntime<boolean>({ type: "cache.delete", key }),
        false
      ),
    clear: () =>
      cacheCall(
        "清空",
        null,
        () => sendRuntime<boolean>({ type: "cache.clear" }),
        false
      ),
    trimExpired: () =>
      cacheCall(
        "清理过期",
        null,
        () => sendRuntime<number>({ type: "cache.trim" }),
        0
      )
  };
}

export async function readRuntimeSettings(): Promise<RuntimeSettings> {
  return sendRuntime<RuntimeSettings>({ type: "settings.get" });
}

export async function readDecisionSettings(): Promise<DecisionConfig> {
  return sendRuntime<DecisionConfig>({ type: "settings.getDecisionConfig" });
}

export async function writeDecisionSettings(
  patch: Partial<DecisionConfig>
): Promise<DecisionConfig> {
  return sendRuntime<DecisionConfig>({ type: "settings.setDecisionConfig", patch });
}

/** 读取本机累计的跳过统计；后台不可用时按零处理，不阻塞设置页。 */
export async function readSkipTotals(): Promise<SkipTotals> {
  try {
    const value = await sendRuntime<SkipTotals | null>({ type: "metrics.get" });
    return value ?? EMPTY_SKIP_TOTALS;
  } catch (error) {
    logWarn("读取统计数据失败，按空数据处理", errorText(error));
    return EMPTY_SKIP_TOTALS;
  }
}

export async function recordSkip(seconds: number): Promise<void> {
  await sendRuntime({ type: "metrics.skip", seconds });
}

export async function recordUndo(): Promise<void> {
  await sendRuntime({ type: "metrics.undo" });
}

export async function clearMetrics(): Promise<void> {
  await sendRuntime({ type: "metrics.clear" });
}

/** 读取某条视频的「不是广告」标记；读不到按空处理，不影响分析。 */
export async function readIgnoredKeys(videoKey: string): Promise<string[]> {
  try {
    const value = await sendRuntime<unknown>({ type: "ignore.get", videoKey });
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch (error) {
    logWarn("读取「不是广告」标记失败，按空处理", { videoKey, error: errorText(error) });
    return [];
  }
}

/** 追加一条「不是广告」标记；写失败只记日志，用户仍能在本次会话里看到效果。 */
export async function addIgnoredKey(videoKey: string, segmentKey: string): Promise<void> {
  try {
    await sendRuntime({ type: "ignore.add", videoKey, segmentKey });
  } catch (error) {
    logWarn("保存「不是广告」标记失败", { videoKey, segmentKey, error: errorText(error) });
  }
}

