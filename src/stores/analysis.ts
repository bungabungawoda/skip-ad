import { create } from "zustand";
import type { UiState } from "../core/ui/state";

/**
 * 分析状态分片：内容脚本产生快照，Popup 打开时通过消息拉取后写进这里。
 * Key 与额外请求头永远不会出现在这个 store 里。
 */
interface AnalysisStore {
  state: UiState | null;
  setState: (state: UiState) => void;
  clear: () => void;
}

export const useAnalysisStore = create<AnalysisStore>((set) => ({
  state: null,
  setState: (state) => set({ state }),
  clear: () => set({ state: null })
}));
