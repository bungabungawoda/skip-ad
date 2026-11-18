import type { SiteManifest } from "../core/plugin/types";

/**
 * 构建期 Manifest 汇总：site.json 是页面匹配与权限声明的唯一来源。
 * 纯函数，tests/build-manifest.test.ts 直接测试；wxt.config.ts 在
 * build:manifestGenerated 钩子里把扫描到的 site.json 交给它。
 * site.json 的解析与校验在 core/plugin/manifest，运行期插件注册共用同一份。
 */

/** WXT 生成的 Manifest 形状（只关心本函数读写的字段）。 */
export interface WxtManifest {
  content_scripts?: Array<Record<string, unknown>>;
  host_permissions?: string[];
  web_accessible_resources?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Chrome 的 web_accessible_resources[].matches 只按 origin 匹配，路径必须是 /*。
 * 内容脚本的 https://example.com/video/* 写在这里会让扩展加载失败：
 * "Invalid value for 'web_accessible_resources[0]'. Invalid match pattern."
 */
function toOriginPattern(pattern: string): string {
  if (pattern === "<all_urls>") return pattern;
  const parsed = /^([a-z*]+):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!parsed) {
    throw new Error(`非法的 match pattern：${pattern}（web_accessible_resources 只接受 origin）`);
  }
  return `${parsed[1]}://${parsed[2]}/*`;
}

/**
 * 合并各站声明：
 * - host_permissions 取基础值与各站 hostPermissions 的并集（去重，顺序稳定）。
 * - 隔离世界的共享内容脚本：matches 替换为各站 contentMatches 的并集，
 *   excludeMatches 并集非空时写入 exclude_matches。
 * - MAIN 世界脚本是站点专用的桥（例如 YouTube 播放器桥），保留自己声明的 matches；
 *   它们不能用「各站并集」，否则会把 YouTube 桥注入到 B 站。
 * - web_accessible_resources 的 matches 归一化为只含 origin 的模式，
 *   避免带具体路径的 contentMatches 让 Chrome 拒绝加载扩展。
 * 其余字段原样保留。返回新对象，不修改入参。
 */
export function mergeSiteManifests(
  sites: SiteManifest[],
  base: WxtManifest
): WxtManifest {
  const seenIds = new Set<string>();
  for (const site of sites) {
    if (seenIds.has(site.id)) {
      throw new Error(`site.json id 重复：${site.id}`);
    }
    seenIds.add(site.id);
  }

  const manifest: WxtManifest = { ...base };
  manifest.host_permissions = dedup([
    ...(base.host_permissions ?? []),
    ...sites.flatMap((site) => site.hostPermissions)
  ]);

  const contentMatches = dedup(sites.flatMap((site) => site.contentMatches));
  const excludeMatches = dedup(sites.flatMap((site) => site.excludeMatches));
  // 内容脚本注入的站点扩大了，shadow-root UI 的 CSS 也必须对这些站点可访问。
  // 但不能照抄 contentMatches：它带具体路径，本字段只允许写 origin。
  if (Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources = manifest.web_accessible_resources.map((entry) => {
      const record = entry as Record<string, unknown>;
      const rawMatches = record.matches;
      if (!Array.isArray(rawMatches)) return { ...record };
      const matches = rawMatches.filter((item): item is string => typeof item === "string");
      return { ...record, matches: dedup([...matches, ...contentMatches].map(toOriginPattern)) };
    });
  }
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0) {
    manifest.content_scripts = manifest.content_scripts.map((script) => {
      if (script.world === "MAIN") return { ...script };
      return {
        ...script,
        matches: contentMatches,
        ...(excludeMatches.length > 0 ? { exclude_matches: excludeMatches } : {})
      };
    });
  }
  return manifest;
}
