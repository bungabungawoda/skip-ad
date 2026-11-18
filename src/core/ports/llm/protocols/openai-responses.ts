/** OpenAI Responses：系统提示走顶层 instructions，正文在 output 里 type=message 的 output_text 段。 */

import { isRecord } from "../../../lib/record";
import type { ProtocolAdapter, ProtocolReply, StopReason } from "./types";
import { readString, requireText, resolveEndpoint, textFromParts } from "./shared";

const PATH = "/responses";

function joinSystem(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

function responsesUrl(baseUrl: string): string {
  return resolveEndpoint(baseUrl, PATH, false) ?? "";
}

function stopReason(record: Record<string, unknown>): StopReason {
  if (record.status === "failed") return "other";
  if (record.status === "incomplete") {
    const details = isRecord(record.incomplete_details) ? record.incomplete_details : {};
    if (readString(details, "reason") === "max_output_tokens") return "length";
    return "other";
  }
  return "stop";
}

function collectText(record: Record<string, unknown>): string | undefined {
  const output = Array.isArray(record.output) ? record.output : [];
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const text =
      textFromParts(item.content, "output_text") ?? textFromParts(item.content, "text");
    if (text !== undefined) texts.push(text);
  }
  if (texts.length > 0) return texts.join("");
  // 少数网关直接把拼好的正文放在顶层。
  return typeof record.output_text === "string" ? record.output_text : undefined;
}

export const openaiResponses: ProtocolAdapter = {
  id: "openai-responses",

  resolveUrl: (baseUrl) => resolveEndpoint(baseUrl, PATH, false),

  authHeaders(apiKey): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  },

  build(input) {
    const url = responsesUrl(input.baseUrl);
    if (!url) throw new Error("端点地址无效");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.authHeaders(input.apiKey)
    };
    return {
      url,
      headers,
      body: {
        model: input.model,
        instructions: joinSystem(input.messages),
        // 消息数组原样透传（system 提出来放 instructions），保住服务商的前缀缓存。
        input: input.messages.filter((message) => message.role !== "system"),
        max_output_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        store: false,
        ...(input.jsonObject ? { text: { format: { type: "json_object" } } } : {})
      }
    };
  },

  parse(payload): ProtocolReply {
    const record = isRecord(payload) ? payload : {};
    const text = requireText(collectText(record), "output[].content[].text");
    const status = readString(record, "status");
    const details = isRecord(record.incomplete_details) ? record.incomplete_details : {};
    const raw = readString(details, "reason") ?? status;
    return { text, stopReason: stopReason(record), rawStopReason: raw };
  }
};
