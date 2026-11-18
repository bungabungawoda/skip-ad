import type { StorageAreaLike } from "./cache/store";
import { isRecord } from "../lib/record";

/**
 * 每站启用开关：Options 写，内容脚本经 settings.get 读取。
 * 缺省全部开启；没有平台广告能力的站点上，platformAdSkip 无效果。
 */
export interface SiteSwitches {
  /** 本站总开关；关闭后该站不做任何事。 */
  enabled: boolean;
  /** 自动快进平台广告（默认开，不依赖 Key）。 */
  platformAdSkip: boolean;
  /** 分析视频内广告（默认开，需要可用模型配置与字幕）。 */
  segmentAnalysis: boolean;
}

export const DEFAULT_SITE_SWITCHES: SiteSwitches = {
  enabled: true,
  platformAdSkip: true,
  segmentAnalysis: true
};

export const SITE_SWITCHES_STORAGE_KEY = "site-switches";

export type SiteSwitchConfig = Record<string, SiteSwitches>;

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 规范化每站开关：未知站点补默认值，非法字段回退默认。 */
export function normalizeSiteSwitches(raw: unknown): SiteSwitchConfig {
  if (!isRecord(raw)) return {};
  const config: SiteSwitchConfig = {};
  for (const [siteId, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    config[siteId] = {
      enabled: readBool(value.enabled, DEFAULT_SITE_SWITCHES.enabled),
      platformAdSkip: readBool(value.platformAdSkip, DEFAULT_SITE_SWITCHES.platformAdSkip),
      segmentAnalysis: readBool(value.segmentAnalysis, DEFAULT_SITE_SWITCHES.segmentAnalysis)
    };
  }
  return config;
}

export function siteSwitchesFor(
  config: SiteSwitchConfig,
  siteId: string
): SiteSwitches {
  return config[siteId] ?? { ...DEFAULT_SITE_SWITCHES };
}

export async function readSiteSwitches(area: StorageAreaLike): Promise<SiteSwitchConfig> {
  const stored = await area.get(SITE_SWITCHES_STORAGE_KEY);
  return normalizeSiteSwitches(stored[SITE_SWITCHES_STORAGE_KEY]);
}

/** 按站点合并一次改动：两个设置页各写自己的站点时不会互相抹掉。 */
export async function writeSiteSwitches(
  area: StorageAreaLike,
  patch: Record<string, Partial<SiteSwitches>>
): Promise<SiteSwitchConfig> {
  const current = await readSiteSwitches(area);
  const next = { ...current };
  for (const [siteId, value] of Object.entries(patch)) {
    if (!isRecord(value)) continue;
    const stored = siteSwitchesFor(current, siteId);
    const merged = { ...stored, ...value };
    const normalized = normalizeSiteSwitches({ [siteId]: merged })[siteId];
    if (normalized) next[siteId] = normalized;
  }
  await area.set({ [SITE_SWITCHES_STORAGE_KEY]: next });
  return next;
}
