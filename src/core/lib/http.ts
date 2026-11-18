/** fetch 的最小契约：B 站客户端与 LLM 客户端共用，便于注入假实现。 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 只留下协议、主机和路径。
 * 自定义网关可能把 Key 放在查询串里，调用明细不能因此把 Key 一起存下来。
 */
export function safeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}
