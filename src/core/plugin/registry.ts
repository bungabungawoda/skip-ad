import type { SitePlugin } from "./types";

/**
 * 网站插件注册表：构建期通过 Vite 的 import.meta.glob 加载各网站目录的 index.ts，
 * 新增网站不需要改内容脚本入口。
 */

const modules = import.meta.glob("../../sites/*/index.ts", { eager: true });

function isSitePlugin(value: unknown): value is SitePlugin {
  if (typeof value !== "object" || value === null) return false;
  const plugin = value as Partial<SitePlugin>;
  return (
    typeof plugin.id === "string" &&
    plugin.id.length > 0 &&
    typeof plugin.manifest === "object" &&
    plugin.manifest !== null &&
    typeof plugin.match === "function" &&
    typeof plugin.create === "function"
  );
}

let cached: SitePlugin[] | null = null;

/** 加载并校验各站插件；模块级只做一次，Popup 每秒轮询不会重复校验。 */
export function loadSitePlugins(): SitePlugin[] {
  if (cached) return cached;
  const plugins: SitePlugin[] = [];
  for (const [path, module] of Object.entries(modules)) {
    const exported = (module as { default?: unknown }).default;
    if (!isSitePlugin(exported)) {
      throw new Error(`网站插件 ${path} 缺少完整的 default 导出（id、manifest、match、create）`);
    }
    plugins.push(exported);
  }
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new Error(`网站插件 id 重复：${plugin.id}`);
    }
    seen.add(plugin.id);
  }
  // 按 id 排序保证插件选择顺序稳定。
  cached = plugins.sort((a, b) => a.id.localeCompare(b.id));
  return cached;
}

/** 按 URL 选插件；没有匹配的网站返回 null。 */
export function findSitePlugin(url: URL, plugins: SitePlugin[]): SitePlugin | null {
  return plugins.find((plugin) => plugin.match(url)) ?? null;
}
