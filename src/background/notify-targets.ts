/**
 * 「设置变了」要推给哪些标签页。
 *
 * 后台只导入各站的 site.json（纯 JSON），不经过插件注册表：
 * 注册表会连带把站点分析器拖进 Service Worker。
 * 新增站点时在这里补一行；`notify-targets.test.ts` 会对照磁盘上的 site.json
 * 检查有没有漏掉的站，漏了测试就红。
 */

import bilibiliSite from "../sites/bilibili/site.json";
import youtubeSite from "../sites/youtube/site.json";

const SITE_MANIFESTS: ReadonlyArray<{ contentMatches?: readonly string[] }> = [
  bilibiliSite,
  youtubeSite
];

/** 内容脚本的匹配模式，用于 chrome.tabs.query({ url }) 过滤目标标签页。 */
export function contentScriptMatchPatterns(): string[] {
  const patterns = new Set<string>();
  for (const manifest of SITE_MANIFESTS) {
    for (const pattern of manifest.contentMatches ?? []) {
      if (pattern) patterns.add(pattern);
    }
  }
  return [...patterns];
}

/** 设置变更要通知视频页与扩展设置页，两类地址分开查询。 */
export function settingsChangeTargets(): { contentUrls: string[]; optionsUrl: string } {
  return {
    contentUrls: contentScriptMatchPatterns(),
    optionsUrl: chrome.runtime.getURL("options.html")
  };
}
