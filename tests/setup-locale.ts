/**
 * 所有测试按中文界面跑，现有断言和测试数据都按这个语言写。
 * 英文文案在 i18n 测试里直接用 translate("en", …) 验证。
 */

const locale = "zh-CN";

if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", {
    configurable: true,
    get: () => locale
  });
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    get: () => [locale]
  });
}
