/**
 * HTTP 失败的分类：LLM 与决策接口共用这一套词，调用方据此决定要不要重试。
 *
 * 分类只看状态码和错误正文，不看是哪个服务商。401/403 是 Key 问题，
 * 429 是限流，404 要分「模型不存在」和「路径不对」，其余 4xx 是请求本身有问题。
 */

import type { LlmErrorKind } from "./llm/errors";

const MODEL_NOT_FOUND = /model_not_found|model[^\n]{0,40}(not found|does not exist|unknown)/i;

export function classifyHttpStatus(status: number, detail: string): LlmErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 402) return "quota";
  if (status === 404) return MODEL_NOT_FOUND.test(detail) ? "not_found" : "path_not_found";
  if (/insufficient_quota|exceeded your current quota|billing/i.test(detail)) return "quota";
  if (status >= 500) return "server";
  return "bad_request";
}

/** 服务端给的退避时间优先于本地默认值：限流时按它给的秒数等，别硬撞。 */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * 从错误正文里读服务端建议的等待时间。
 *
 * Gemini 的免费档限流响应只有正文，没有 Retry-After 头：
 * `{"error":{"message":"... Please retry in 37s ..."}}`。
 * 不读这段就只能按本地退避硬撞，37 秒的窗口用 1/2/4 秒重试三次全部失败。
 */
const RETRY_DELAY_TEXT =
  /retry(?:ing)?[\s_-]*(?:after|in|delay)?[\s:="']*(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)\b/i;

export function retryAfterFromDetail(detail: string): number | undefined {
  const match = detail.match(RETRY_DELAY_TEXT);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
