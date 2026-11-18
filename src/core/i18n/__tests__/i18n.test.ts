import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentLocale, resolveLocale, t, translate } from "..";
import { MESSAGES } from "../messages";

const LOCALES = new URL("../../../public/_locales/", import.meta.url);

function readMessages(locale: string): Record<string, { message: string }> {
  return JSON.parse(readFileSync(new URL(`${locale}/messages.json`, LOCALES), "utf8"));
}

describe("interface locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Chinese for any Chinese browser language and English for everything else", () => {
    expect(resolveLocale("zh-CN")).toBe("zh");
    expect(resolveLocale("zh-TW")).toBe("zh");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("fr-FR")).toBe("en");
    expect(resolveLocale("")).toBe("en");
  });

  it("uses the test navigator language and translates variables", () => {
    expect(t("app.name")).toBe("跳过助手");
    expect(t("common.seconds", { count: 3 })).toBe("3 秒");
    expect(translate("en", "common.seconds", { count: 3 })).toBe("3s");
  });

  it("follows the browser UI language, then falls back to navigator", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "en-US" }
    });
    expect(currentLocale()).toBe("en");
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "zh-CN" }
    });
    expect(currentLocale()).toBe("zh");
    vi.stubGlobal("chrome", {});
    expect(currentLocale()).toBe("zh");
  });

  it("keeps the English interface free of Chinese text", () => {
    for (const [key, value] of Object.entries(MESSAGES.en)) {
      expect(value, key).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("keeps both manifest locales in sync and using placeholders", () => {
    const en = readMessages("en");
    const zh = readMessages("zh_CN");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const file of [en, zh]) {
      expect(file.extensionName?.message.length).toBeGreaterThan(0);
      expect(file.extensionDescription?.message.length).toBeGreaterThan(0);
      expect(file.actionTitle?.message.length).toBeGreaterThan(0);
    }
    expect(zh.extensionName?.message).toMatch(/[\u4e00-\u9fff]/);
    expect(en.extensionName?.message).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
