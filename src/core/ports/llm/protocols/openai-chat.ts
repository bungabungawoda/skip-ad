/** OpenAI Chat Completions：系统提示放在 messages[0]，正文在 choices[0].message.content。 */

import { isRecord } from "../../../lib/record";
import { ReplyShapeError } from "../errors";
import type { ProtocolAdapter, ProtocolReply, StopReason } from "./types";
import { readString, requireText, resolveEndpoint, textFromParts } from "./shared";

const PATH = "/chat/completions";

function chatUrl(baseUrl: string): string {
  return resolveEndpoint(baseUrl, PATH, false) ?? "";
}

function stopReason(raw: string | null): StopReason {
  if (raw === null || raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "filter";
  return "other";
}

function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export const openaiChat: ProtocolAdapter = {
  id: "openai-chat",

  resolveUrl: (baseUrl) => resolveEndpoint(baseUrl, PATH, false),

  authHeaders: bearer,

  build(input) {
    const url = chatUrl(input.baseUrl);
    if (!url) throw new Error("端点地址无效");
    return {
      url,
      headers: { "Content-Type": "application/json", ...bearer(input.apiKey) },
      body: {
        model: input.model,
        // 消息数组原样透传：保持 system + user/assistant 交替的形状，
        // 服务商的自动前缀缓存才能命中上一轮请求的全部内容。
        messages: input.messages,
        // 不传时服务端默认上限（DeepSeek 是 4096）会把长片段表截在半句 JSON 上。
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        stream: false,
        ...(input.jsonObject ? { response_format: { type: "json_object" } } : {})
      }
    };
  },

  parse(payload): ProtocolReply {
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0];
    if (!isRecord(first)) throw new ReplyShapeError("响应里没有 choices[0]");
    const message = isRecord(first.message) ? first.message : {};
    const text = requireText(
      textFromParts(message.content, "text"),
      "choices[0].message.content"
    );
    const raw = readString(first, "finish_reason");
    return { text, stopReason: stopReason(raw), rawStopReason: raw };
  }
};
