/**
 * 端点地址的放行规则：https 随便填，http 只给本机回环。
 *
 * 本地网关（例如 magpie 跑在 127.0.0.1:3425）走明文 http，浏览器对它是本机
 * 通信，不需要证书；其它主机一律要求 https，否则等于让 Key 明文过网。
 */

/** 只认这两个写法：localhost 与点分 127.0.0.1。IPv6 回环的权限模式在 Chrome 里不可用，不支持。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * 用户粘贴地址时经常省略协议。没有协议的 https 地址补成 https://，
 * 回环地址补成 http://；明显不是地址的短文本原样返回，避免边输入边乱跳。
 */
export function normalizeEndpointText(raw: string): string {
  const text = raw.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(text)) {
    return `http://${text}`;
  }
  return text.includes(".") ? `https://${text}` : text;
}

export function parseEndpointUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/** 用户输入框专用：先补默认协议，再按端点规则校验。 */
export function parseEndpointInput(raw: string): URL | null {
  return parseEndpointUrl(normalizeEndpointText(raw));
}

export function isEndpointUrl(raw: string): boolean {
  return parseEndpointUrl(raw) !== null;
}
