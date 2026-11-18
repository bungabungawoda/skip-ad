/**
 * Chrome match pattern 的最小实现：只支持本扩展用到的形态
 * `<scheme>://<host>/<path>`，星号只出现在路径末尾。
 * 运行时 match() 与构建期 site.json 用同一份声明，避免两处漂移。
 *
 * 语义与 Chrome 一致：路径以 `/*` 结尾时匹配该前缀下的所有路径
 * （不含去掉斜杠的裸前缀）；以裸 `*` 结尾时按前缀匹配。
 */
export function urlMatchesPattern(url: URL, pattern: string): boolean {
  const match = pattern.match(/^(https?):\/\/([^/*]+)(\/.*)$/);
  if (!match) return false;
  const scheme = match[1];
  const host = match[2];
  const path = match[3];
  if (!scheme || !host || !path) return false;
  if (url.protocol !== `${scheme}:` || url.hostname !== host) return false;
  if (path === "/*") return true;
  if (path.endsWith("*")) {
    return url.pathname.startsWith(path.slice(0, -1));
  }
  return url.pathname === path || url.pathname.startsWith(`${path}/`);
}
