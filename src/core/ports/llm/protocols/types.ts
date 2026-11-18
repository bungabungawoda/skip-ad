/** 线协议适配器的类型契约：一种协议只做补地址、拼请求、解响应三件事。 */

import type { LlmMessage } from "../types";

export type ProtocolId = "openai-chat" | "openai-responses" | "anthropic";

export type StopReason = "stop" | "length" | "filter" | "other";

export interface BuildInput {
  /** 用户或预设给的地址；可以是基础地址，也可以是完整端点。 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 完整的消息数组（system 开头，user/assistant 交替）。原样透传给协议拼装。 */
  messages: LlmMessage[];
  maxOutputTokens: number;
  temperature: number;
  /** 能力位：这家认不认结构化输出开关。 */
  jsonObject: boolean;
}

interface ProtocolRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProtocolReply {
  text: string;
  stopReason: StopReason;
  rawStopReason: string | null;
}

export interface ProtocolAdapter {
  id: ProtocolId;
  /** 把用户填的地址补成最终请求地址；地址不合法返回 null。 */
  resolveUrl(baseUrl: string): string | null;
  /** 只含鉴权相关的头，不含 Content-Type；列模型列表时也用它。 */
  authHeaders(apiKey: string): Record<string, string>;
  build(input: BuildInput): ProtocolRequest;
  parse(payload: unknown): ProtocolReply;
}
