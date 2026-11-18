import { t, type MessageKey } from "../../core/i18n";

/** 连接失败只给人话；技术细节折叠在后面，想看的人自己展开。 */
const ERROR_TEXT: Record<string, MessageKey> = {
  auth: "connectionError.auth",
  quota: "connectionError.quota",
  rate_limit: "connectionError.rate_limit",
  path_not_found: "connectionError.path_not_found",
  not_found: "connectionError.not_found",
  bad_request: "connectionError.bad_request",
  timeout: "connectionError.timeout",
  network: "connectionError.network",
  cancelled: "connectionError.cancelled"
};

function errorKindOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return "network";
}

export function humanError(error: unknown): string {
  return t(ERROR_TEXT[errorKindOf(error)] ?? "connectionError.fallback");
}
