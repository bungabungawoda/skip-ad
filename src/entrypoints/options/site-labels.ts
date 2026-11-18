import { t } from "../../core/i18n";

/**
 * 站点 id 的展示名：设置页与统计页共用一份，避免同一个站点在两处叫不同的名字。
 * 未知 id 原样返回，新站点没来得及补名字时也不会显示成空。
 */
const SITE_NAMES: Record<string, string> = {
  bilibili: t("site.bilibili"),
  youtube: "YouTube"
};

export function siteName(id: string): string {
  return SITE_NAMES[id] ?? id;
}
