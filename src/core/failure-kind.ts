/**
 * 失败类别的唯一来源：重试判断、后台错误透传和界面文案都从这里取词。
 * 新增一种失败时先加进对应分组，不要让各处各记一份字符串集合。
 */

/** 同一请求再发一次可能成功的失败；所有请求只在这一层重试。 */
export const RETRYABLE_FAILURES = [
  "rate_limit",
  "server",
  "network",
  "timeout",
  "shape"
] as const;

/** 后台消息边界要保留原类别，避免调用方把所有错误都当成网络问题。 */
export const FORWARDED_ERROR_KINDS = [
  "auth",
  "not_found",
  "path_not_found",
  "bad_request",
  "quota",
  ...RETRYABLE_FAILURES,
  "truncated",
  "cancelled",
  "not_configured"
] as const;

export function isRetryableRequestFailure(kind: string): boolean {
  return (RETRYABLE_FAILURES as readonly string[]).includes(kind);
}

export function isForwardedErrorKind(kind: string): boolean {
  return (FORWARDED_ERROR_KINDS as readonly string[]).includes(kind);
}
