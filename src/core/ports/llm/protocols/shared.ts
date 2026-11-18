/** 三种协议共用的地址补全与正文提取；不掺任何一家特有的字段名。 */

import { isRecord } from "../../../lib/record";
import { ReplyShapeError } from "../errors";
import { parseEndpointUrl } from "../endpoint";

/** 解析用户填的地址：https 随便填，http 只放行本机回环（本地网关）。 */
export const parseBaseUrl = parseEndpointUrl;

/**
 * 把基础地址补成完整请求地址。
 * 已经以端点路径结尾的地址原样使用；versioned 的协议（Anthropic）只在末尾不是 /v1 时补一层。
 */
export function resolveEndpoint(
  baseUrl: string,
  endpointPath: string,
  versioned: boolean
): string | null {
  const url = parseBaseUrl(baseUrl);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(endpointPath)) return `${url.origin}${path}`;
  if (versioned && path.endsWith("/v1")) return `${url.origin}${path}${endpointPath}`;
  return `${url.origin}${path}${versioned ? "/v1" : ""}${endpointPath}`;
}

/** 从 content 里拼出文本：既接受字符串，也接受 [{type, text}] 这种分段。 */
export function textFromParts(content: unknown, partType: string): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type !== partType) continue;
    if (typeof part.text === "string") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

export function readString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

/** 正文缺失时统一抛形状错误，调用方据此把这次调用记成「服务端已计费但解析失败」。 */
export function requireText(value: string | undefined, where: string): string {
  if (value === undefined) throw new ReplyShapeError(`响应里没有 ${where}`);
  return value;
}
