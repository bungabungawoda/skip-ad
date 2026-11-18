import { create } from "zustand";
import type { SegmentKind } from "../core/plugin/types";
import type { SkipStats } from "../core/ui/state";
import { EMPTY_SKIP_STATS } from "../core/ui/state";

/** Toast 的三种形态：自动跳、手动跳共用 skipped，撤销后是 undone，主题内容点击是 info。 */
export interface ToastInfo {
  segmentKey: string;
  kind: SegmentKind;
  start: number;
  end: number;
  confidence: number;
  mode: "skipped" | "undone" | "info";
  /** 手动点胶囊或 Popup 触发；自动跳为 false。 */
  manual: boolean;
  /** 撤销后实际回到的播放位置。 */
  undoTo?: number;
  shownAt: number;
}

/**
 * 内容脚本会话分片：Toast、撤销窗口、本地统计。
 * 只存在于内容脚本内存，不持久化，Service Worker 不读它。
 */
interface SessionStore {
  toast: ToastInfo | null;
  stats: SkipStats;
  showToast: (toast: Omit<ToastInfo, "shownAt">) => void;
  clearToast: () => void;
  recordSkip: (seconds: number) => void;
  recordUndo: () => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  toast: null,
  stats: { ...EMPTY_SKIP_STATS },
  showToast: (toast) => set({ toast: { ...toast, shownAt: Date.now() } }),
  clearToast: () => set({ toast: null }),
  recordSkip: (seconds) =>
    set((state) => ({
      stats: {
        ...state.stats,
        skippedCount: state.stats.skippedCount + 1,
        skippedSeconds: state.stats.skippedSeconds + Math.max(0, seconds)
      }
    })),
  recordUndo: () =>
    set((state) => ({
      stats: { ...state.stats, undoCount: state.stats.undoCount + 1 }
    }))
}));
