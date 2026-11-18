import { createRoot } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { PlayerOverlay } from "./overlay";
import { mountProgressMarks } from "./progress-marks-mount";
import type { OverlayAdapter } from "../core/plugin/types";
import { useSessionStore } from "../stores/session";
import { errorText } from "../core/lib/error";
import { logInfo, logWarn } from "../core/lib/log";

interface OverlayHandlers {
  onUndo: (key: string | undefined) => void;
  /** 点胶囊或松手吸附时执行手动跳。 */
  onSkip: (key: string) => void;
  /** 当前播放器 video；预览环从播放位置弹到片段结尾时用。 */
  getVideo: () => HTMLVideoElement | null;
}

/** 宿主层：订阅 store 并注入 Toast，播放器浮层本身保持无状态依赖。 */
function OverlayHost(handlers: OverlayHandlers) {
  const toast = useSessionStore((state) => state.toast);
  const clearToast = useSessionStore((state) => state.clearToast);
  return (
    <PlayerOverlay toast={toast} clearToast={clearToast} onUndo={handlers.onUndo} />
  );
}

/**
 * 播放器浮层挂载：Toast 挂到站点提供的容器锚点，片段色块画进原生进度条。
 * 挂载失败只降级浮层，自动跳与 Popup 不受影响。
 *
 * @returns 清理函数：移除进度条色块并退订 store。
 */
export function mountPlayerOverlay(
  ctx: ContentScriptContext,
  overlay: OverlayAdapter,
  handlers: OverlayHandlers
): () => void {
  const disposeMarks = mountProgressMarks(ctx, overlay, {
    getVideo: handlers.getVideo,
    onSkip: handlers.onSkip
  });

  void createShadowRootUi(ctx, {
    name: "skipad-player-ui",
    position: "inline",
    anchor: overlay.anchor,
    onMount(container) {
      const wrapper = document.createElement("div");
      wrapper.className = "skipad";
      wrapper.dataset.theme = "dark";
      wrapper.style.position = "absolute";
      wrapper.style.inset = "0";
      wrapper.style.zIndex = "75";
      wrapper.style.pointerEvents = "none";
      container.append(wrapper);
      const root = createRoot(wrapper);
      root.render(<OverlayHost {...handlers} />);
      return root;
    },
    onRemove(root) {
      root?.unmount();
    }
  })
    .then((ui) => {
      ui.autoMount();
      logInfo("播放器浮层已挂载");
    })
    .catch((error: unknown) => {
      // 浮层挂载失败时仍执行自动跳，Popup 照常可用。
      logWarn("播放器浮层挂载失败，自动跳不受影响", errorText(error));
    });

  return disposeMarks;
}
