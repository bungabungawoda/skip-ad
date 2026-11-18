/** 协议注册表：按 id 取适配器，或从完整端点路径反推协议。 */

import type { ProtocolAdapter, ProtocolId } from "./types";
import { openaiChat } from "./openai-chat";
import { openaiResponses } from "./openai-responses";
import { anthropic } from "./anthropic";
import { parseBaseUrl } from "./shared";

export type { BuildInput, ProtocolAdapter, ProtocolId, ProtocolReply, StopReason } from "./types";
export { openaiChat, openaiResponses, anthropic };

const BY_ID: Record<ProtocolId, ProtocolAdapter> = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  anthropic
};

export function protocolById(id: ProtocolId): ProtocolAdapter {
  return BY_ID[id];
}

/** 地址里已经写了完整端点时，直接据此确定协议；否则交给探测定。 */
export function detectProtocolFromUrl(raw: string): ProtocolId | undefined {
  const url = parseBaseUrl(raw);
  if (!url) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return "openai-chat";
  if (path.endsWith("/responses")) return "openai-responses";
  if (path.endsWith("/messages")) return "anthropic";
  return undefined;
}
