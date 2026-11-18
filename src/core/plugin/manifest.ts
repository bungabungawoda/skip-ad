import type { SiteCapability, SiteManifest } from "./types";
import { SITE_CAPABILITIES } from "./types";

/**
 * site.json 的解析与校验：构建期汇总 manifest 与运行期插件注册共用这一份，
 * 字段非法时报错而不是静默跳过。
 */

function readStringArray(value: unknown, field: string, siteId: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`site.json（${siteId}）的字段 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

function readCapabilities(value: unknown, siteId: string): SiteCapability[] {
  const raw = value ?? [];
  const list = readStringArray(raw, "capabilities", siteId);
  const known = new Set<string>(SITE_CAPABILITIES);
  for (const item of list) {
    if (!known.has(item)) {
      throw new Error(`site.json（${siteId}）含未知能力 ${item}`);
    }
  }
  return list as SiteCapability[];
}

export function parseSiteManifest(raw: unknown, source = "site.json"): SiteManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source} 不是对象`);
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${source} 缺少非空字符串的 id`);
  }
  return {
    id,
    contentMatches: readStringArray(record.contentMatches, "contentMatches", id),
    excludeMatches: readStringArray(record.excludeMatches ?? [], "excludeMatches", id),
    hostPermissions: readStringArray(record.hostPermissions ?? [], "hostPermissions", id),
    capabilities: readCapabilities(record.capabilities, id)
  };
}
