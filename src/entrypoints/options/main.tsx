import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { applyTheme, useSettingsStore } from "../../stores/settings";
import App from "./App";
import { localeTag, t } from "../../core/i18n";

const container = document.getElementById("root");
if (!container) throw new Error("Options 缺少 #root 容器");

document.documentElement.lang = localeTag();
document.title = `${t("app.name")} · ${t("common.settings")}`;

applyTheme(document.documentElement, useSettingsStore.getState().theme);
useSettingsStore.subscribe((state, prev) => {
  if (state.theme !== prev.theme) {
    applyTheme(document.documentElement, state.theme);
  }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyTheme(document.documentElement, useSettingsStore.getState().theme);
});

createRoot(container).render(<App />);
