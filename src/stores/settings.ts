import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";

type ThemeSetting = "system" | "light" | "dark";

/**
 * 偏好设置分片：主题与 Options 左栏宽度。
 * 类型顺序与策略一起存在 storage.local 的 analysis 键里，不在这里再存一份。
 */
interface SettingsState {
  theme: ThemeSetting;
  panelWidth: number;
  setTheme: (theme: ThemeSetting) => void;
  setPanelWidth: (width: number) => void;
}

/** Zustand persist 的 chrome.storage.local 适配器，只用于非敏感偏好。 */
const chromeLocalStorage: StateStorage = {
  getItem: async (name) => {
    const items = await chrome.storage.local.get(name);
    return (items[name] as string | undefined) ?? null;
  },
  setItem: async (name, value) => {
    await chrome.storage.local.set({ [name]: value });
  },
  removeItem: async (name) => {
    await chrome.storage.local.remove(name);
  }
};

/** Options 左栏像素约束：界面百分比换算与 store 的 clamp 共用。 */
export const PANEL_MIN_PX = 200;
export const PANEL_MAX_PX = 320;
export const PANEL_DEFAULT_PX = 240;

function clampPanelWidth(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return PANEL_DEFAULT_PX;
  return Math.min(PANEL_MAX_PX, Math.max(PANEL_MIN_PX, Math.round(width)));
}

const SETTINGS_STORAGE_KEY = "ui-settings";

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      panelWidth: PANEL_DEFAULT_PX,
      setTheme: (theme) => set({ theme }),
      setPanelWidth: (width) => set({ panelWidth: clampPanelWidth(width) })
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => chromeLocalStorage),
      partialize: (state) => ({
        theme: state.theme,
        panelWidth: state.panelWidth
      })
    }
  )
);

/** 把主题设置解析成实际应用的 data-theme 值。 */
function resolveTheme(theme: ThemeSetting, prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

function prefersDarkSchema(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 把 data-theme 应用到指定元素，Popup 与 Options 都在 documentElement 上调用。 */
export function applyTheme(element: HTMLElement, theme: ThemeSetting): void {
  element.dataset.theme = resolveTheme(theme, prefersDarkSchema());
}
