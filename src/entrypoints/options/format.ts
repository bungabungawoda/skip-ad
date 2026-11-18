/** 跳过统计页的展示格式化：只处理数字与时长文案。 */

import { localeTag, t } from "../../core/i18n";

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString(localeTag());
}

/** 数值与单位分开返回，卡片才能把数字放大、单位缩小。 */
interface SavedTime {
  value: string;
  unit: string;
}

function oneDecimal(value: number): string {
  const fixed = (Math.round(value * 10) / 10).toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * 省下的时间按量级换单位：够一小时用小时，够一分钟用分钟，再少用秒。
 * 先按分钟四舍五入再判断，59.98 分钟会进位成 1 小时，不会显示「60 分钟」。
 */
export function formatSavedTime(seconds: number): SavedTime {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.round(safe / 60);
  if (minutes >= 60) return { value: oneDecimal(safe / 3600), unit: t("metrics.unit.hours") };
  if (safe >= 60) return { value: String(minutes), unit: t("metrics.unit.minutes") };
  return { value: String(Math.round(safe)), unit: t("metrics.unit.seconds") };
}

/** 明细行用的精确写法：小时带分钟、分钟带秒，不四舍五入掉零头。 */
export function formatSavedDetail(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) {
    return `${hours} ${t("metrics.unit.hoursShort")} ${minutes} ${t("metrics.unit.minutesShort")}`;
  }
  if (minutes > 0) {
    return rest > 0
      ? `${minutes} ${t("metrics.unit.minutesShort")} ${rest} ${t("metrics.unit.secondsShort")}`
      : `${minutes} ${t("metrics.unit.minutes")}`;
  }
  return `${rest} ${t("metrics.unit.seconds")}`;
}

