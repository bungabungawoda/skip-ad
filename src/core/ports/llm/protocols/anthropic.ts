/** Anthropic Messages：系统提示是顶层 system，正文是 content 里 type=text 的段。 */

import { isRecord } from "../../../lib/record";
import { ReplyShapeError } from "../errors";
import type { LlmMessage } from "../types";
import type { ProtocolAdapter, ProtocolReply, StopReason } from "./types";
import { readString, requireText, resolveEndpoint, textFromParts } from "./shared";

const PATH = "/messages";
const VERSION = "2023-06-01";

/** Anthropic 的缓存不是自动的：在最后一条 user 消息上打断点，之前的全部内容进缓存。 */
function withCacheBreakpoint(messages: LlmMessage[]): Array<Record<string, unknown>> {
  let breakpoint = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      breakpoint = index;
      break;
    }
  }
  return messages.map((message, index) =>
    index === breakpoint
      ? {
          role: message.role,
          content: [
            { type: "text", text: message.content, cache_control: { type: "ephemeral" } }
          ]
        }
      : { role: message.role, content: message.content }
  );
}

function joinSystem(messages: LlmMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

function messagesUrl(baseUrl: string): string {
  return resolveEndpoint(baseUrl, PATH, true) ?? "";
}

function stopReason(raw: string | null): StopReason {
  if (raw === null || raw === "end_turn" || raw === "stop_sequence") return "stop";
  if (raw === "max_tokens") return "length";
  if (raw === "refusal") return "filter";
  return "other";
}

export const anthropic: ProtocolAdapter = {
  id: "anthropic",

  resolveUrl: (baseUrl) => resolveEndpoint(baseUrl, PATH, true),

  authHeaders(apiKey) {
    const headers: Record<string, string> = {
      "anthropic-version": VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  },

  build(input) {
    const url = messagesUrl(input.baseUrl);
    if (!url) throw new Error("端点地址无效");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.authHeaders(input.apiKey)
    };
    // 消息数组原样透传（system 提出来放顶层）；最后一条 user 上打断点，
    // 从 system 到该消息的全部内容进提示缓存，下一轮按 1/10 价格读回。
    const messages = withCacheBreakpoint(
      input.messages.filter((message) => message.role !== "system")
    );
    return {
      url,
      headers,
      body: {
        model: input.model,
        system: joinSystem(input.messages),
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        messages
      }
    };
  },

  parse(payload): ProtocolReply {
    const record = isRecord(payload) ? payload : {};
    const content = Array.isArray(record.content) ? record.content : [];
    if (content.length === 0) throw new ReplyShapeError("响应里没有 content");
    const text = requireText(textFromParts(content, "text"), "content[].text");
    const raw = readString(record, "stop_reason");
    return { text, stopReason: stopReason(raw), rawStopReason: raw };
  }
};
