/** LLM 调用的失败分类：协议适配器、客户端与界面共用这一套词。 */

export type LlmErrorKind =
  | "auth"
  | "not_found"
  | "path_not_found"
  | "bad_request"
  | "rate_limit"
  | "quota"
  | "server"
  | "timeout"
  | "cancelled"
  | "network"
  | "shape"
  /** 输出达到 token 上限被截断：重发解析没有意义，要扩大上限后重试。 */
  | "truncated";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;

  constructor(message: string, kind: LlmErrorKind, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** 响应形状不认识：拿到了 2xx，但读不出正文。与网络失败区分开。 */
export class ReplyShapeError extends LlmError {
  constructor(message: string) {
    super(message, "shape");
    this.name = "ReplyShapeError";
  }
}

/**
 * 推理模型把输出额度全花在思考上时，正文会为空。部分 OpenAI 兼容代理
 * 不返回 200 + finish_reason=length，而是报 5xx 并把原因写进正文。
 * 认出这种错误，才能按「截断」扩大上限重试，而不是原样重发。
 */
export function isOutputExhaustedError(detail: string): boolean {
  return /empty reply/i.test(detail) && /reasoning/i.test(detail);
}
