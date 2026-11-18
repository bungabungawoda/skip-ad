/**
 * 决策接口的两种请求格式。
 *
 * 用户只填一个完整地址，这里按地址判断该用哪套协议：
 * - Google Gemini 的 decisions 接口用 { model, input, questions } 和 x-goog-api-key。
 * - TypeSafe 的 System One 接口用 { model, state, questions } 和 Authorization: Bearer。
 *
 * 未知地址按 Google 处理，保持自定义网关原有的行为。
 */

export type DecisionProtocol = "google" | "typesafe";

export function decisionProtocol(endpoint: string): DecisionProtocol {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    if (host.includes("typesafe") || /\/systemone\/?$/i.test(url.pathname)) {
      return "typesafe";
    }
  } catch {
    // 地址还没填完整时按默认协议处理，保存前会再校验一次。
  }
  return "google";
}
