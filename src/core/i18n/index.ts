/**
 * 界面语言：跟着浏览器界面语言走，中文用简体，其余语言用英文。
 *
 * 这里只服务界面文字。模型提示词和日志保持原样，不受浏览器语言影响。
 */

import { MESSAGES, type MessageKey } from "./messages";

export type AppLocale = "zh" | "en";
export type { MessageKey };

export function resolveLocale(language: string | null | undefined): AppLocale {
  return (language ?? "").trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 扩展页面优先问浏览器界面语言；测试和普通网页回退到 navigator。 */
export function browserLanguage(): string {
  try {
    const language = globalThis.chrome?.i18n?.getUILanguage?.();
    if (typeof language === "string" && language.length > 0) return language;
  } catch {
    // 没有扩展 API 时继续用 navigator。
  }
  return typeof navigator !== "undefined" ? navigator.language : "en";
}

export function currentLocale(): AppLocale {
  return resolveLocale(browserLanguage());
}

export function localeTag(locale: AppLocale = currentLocale()): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

function fill(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function translate(
  locale: AppLocale,
  key: MessageKey,
  values?: Record<string, string | number>
): string {
  return fill(MESSAGES[locale][key], values);
}

export function t(
  key: MessageKey,
  values?: Record<string, string | number>
): string {
  return translate(currentLocale(), key, values);
}
