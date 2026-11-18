import type { ContentScriptContext } from "wxt/utils/content-script-context";
import type { OverlayAdapter } from "../core/plugin/types";
import { useAnalysisStore } from "../stores/analysis";
import { createProgressMarksLayer } from "../core/player/progress-marks";
import { buildProgressMarks } from "../core/player/progress-mark-geometry";

interface ProgressMarksHandlers {
  /** 当前播放器 video；预览环从播放位置弹到片段结尾时用。 */
  getVideo: () => HTMLVideoElement | null;
  /** 点胶囊或松手吸附时执行手动跳。 */
  onSkip: (key: string) => void;
}

/**
 * 原生进度条色块与「跳到结尾」胶囊的挂载层：订阅分析快照，把片段换算成色块。
 *
 * 站点会在全屏、切换分 P、播放器重建时替换进度条节点，所以每秒核对一次
 * 轨道是否还在；轨道没变时只做一次 isConnected 检查，开销可以忽略。
 */
export function mountProgressMarks(
  ctx: ContentScriptContext,
  overlay: OverlayAdapter,
  handlers: ProgressMarksHandlers
): () => void {
  const findTrack = (): HTMLElement | null => {
    const anchor = document.querySelector<HTMLElement>(overlay.anchor);
    return (
      anchor?.querySelector<HTMLElement>(overlay.progressAnchor) ??
      document.querySelector<HTMLElement>(overlay.progressAnchor)
    );
  };

  const findSnapHost = (): HTMLElement | null => {
    if (!overlay.snapAnchor) return null;
    const anchor = document.querySelector<HTMLElement>(overlay.anchor);
    return (
      anchor?.querySelector<HTMLElement>(overlay.snapAnchor) ??
      document.querySelector<HTMLElement>(overlay.snapAnchor)
    );
  };

  const layer = createProgressMarksLayer({
    getTrack: findTrack,
    getSnapHost: findSnapHost,
    getVideo: handlers.getVideo,
    onSkip: handlers.onSkip,
    ...(overlay.progressMarksZIndex === undefined
      ? {}
      : { layerZIndex: overlay.progressMarksZIndex }),
    getMarks: () => {
      const snapshot = useAnalysisStore.getState().state;
      return snapshot
        ? buildProgressMarks(snapshot.segments, snapshot.durationSec, snapshot.site)
        : [];
    }
  });

  const unsubscribe = useAnalysisStore.subscribe(() => layer.paint());
  const timer = window.setInterval(() => layer.sync(), 1000);
  layer.sync();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    window.clearInterval(timer);
    layer.dispose();
  };
  ctx.onInvalidated(dispose);
  return dispose;
}
