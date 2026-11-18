import type { SiteAdapter, SiteManifest, SitePlugin } from "./types";
import { urlMatchesPattern } from "./match-pattern";

/**
 * 用 site.json 生成插件：页面匹配、清单与能力来自同一份声明，
 * 站点目录只提供适配器工厂，新增站点不需要再写一份 plugin 对象。
 */
export function defineSitePlugin(
  manifest: SiteManifest,
  create: () => SiteAdapter
): SitePlugin {
  return {
    id: manifest.id,
    manifest,
    match(url) {
      return manifest.contentMatches.some((pattern) => urlMatchesPattern(url, pattern));
    },
    create
  };
}
