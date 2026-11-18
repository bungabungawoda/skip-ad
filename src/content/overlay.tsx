import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Undo2 } from "lucide-react";
import type { Segment } from "../core/plugin/types";
import { formatClock } from "../core/lib/time";
import type { ToastInfo } from "../stores/session";
import { kindLabel } from "../core/policy/kinds";
import { kindSwatchStyle } from "../core/ui/kinds";
import { t } from "../core/i18n";

interface PlayerOverlayProps {
  /** 当前 Toast；由宿主 store 提供。 */
  toast: ToastInfo | null;
  clearToast: () => void;
  onUndo: (key: string | undefined) => void;
}

/** 退场动画时长；与 globals.css 里的 .skipad-toast-leave 保持一致。 */
const TOAST_EXIT_MS = 140;

/**
 * 播放器浮层只留可撤销 Toast。
 * 广告片段由 progress-marks 直接画在站点原生进度条里。
 *
 * 动效只用 CSS：内容脚本每次打开视频页都要解析它，
 * 为一次淡入引入动画库会让每个页面多付出上百 KB 的解析与常驻内存。
 */
export function PlayerOverlay({ toast, clearToast, onUndo }: PlayerOverlayProps): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-[75] overflow-hidden">
      {toast && (
        <ToastCard
          key={toast.shownAt}
          toast={toast}
          clearToast={clearToast}
          onUndo={onUndo}
        />
      )}
    </div>
  );
}

/** Toast 各形态显示多久：跳过 5 秒（倒计时画在进度线里），撤销 4 秒，信息 3 秒。 */
function toastTtl(mode: ToastInfo["mode"]): number {
  return mode === "skipped" ? 5_000 : mode === "undone" ? 4_000 : 3_000;
}

/** Toast 三种形态共用一张卡片：跳过、撤销、主题内容提示。 */
function ToastCard(props: {
  toast: ToastInfo;
  clearToast: () => void;
  onUndo: (key: string | undefined) => void;
}): JSX.Element {
  const { toast, clearToast, onUndo } = props;
  // 到点前 140ms 播退场动画，到点由宿主卸载。计时器回调里改 state，不在渲染期级联。
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const ttl = toastTtl(toast.mode);
    const startExit = window.setTimeout(
      () => setLeaving(true),
      Math.max(0, ttl - TOAST_EXIT_MS)
    );
    const clear = window.setTimeout(clearToast, ttl);
    return () => {
      window.clearTimeout(startExit);
      window.clearTimeout(clear);
    };
  }, [toast, clearToast]);

  const placement = "pointer-events-auto absolute top-6 right-6 w-[308px] rounded-lg p-3";
  return (
    <div
      className={
        toast.mode === "undone"
          ? `${placement} border-2 border-brand bg-surface-raised shadow-popover ${leaving ? "skipad-toast-leave" : "skipad-toast"}`
          : `${placement} border border-[#3A3A42] bg-surface-raised shadow-popover ${leaving ? "skipad-toast-leave" : "skipad-toast"}`
      }
      role="status"
    >
      {toast.mode === "undone" ? (
        <UndoneBody start={toast.start} undoTo={toast.undoTo} />
      ) : toast.mode === "info" ? (
        <InfoBody kind={toast.kind} start={toast.start} end={toast.end} />
      ) : (
        <SkipBody
          kind={toast.kind}
          start={toast.start}
          end={toast.end}
          confidence={toast.confidence}
          manual={toast.manual}
          onUndo={() => onUndo(toast.segmentKey)}
        />
      )}
    </div>
  );
}

function SkipBody(props: {
  kind: Segment["kind"];
  start: number;
  end: number;
  confidence: number;
  manual: boolean;
  onUndo: () => void;
}): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-[3px]" style={kindSwatchStyle(props.kind)} />
        <span className="text-label font-semibold">
          {props.manual ? t("overlay.skippedManual") : t("overlay.skippedAuto")}
          {kindLabel(props.kind)}
        </span>
        <span className="font-mono text-overline text-muted-foreground ml-auto">
          {t("common.seconds", { count: Math.round(props.end - props.start) })}
        </span>
      </div>
      <span className="block text-caption text-[#C6C6CE]">
        {t("overlay.confidence", {
          clock: `${formatClock(props.start)} – ${formatClock(props.end)}`,
          confidence: props.confidence.toFixed(2),
          mode: props.manual ? t("overlay.mode.manual") : t("overlay.mode.auto")
        })}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onUndo}
          className="inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-sm border border-[#6E6E7A] px-2.5 text-caption text-on-player focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          <Undo2 aria-hidden className="size-3" />
          {t("overlay.undo")}
        </button>
        <span className="text-overline text-muted-foreground">{t("overlay.undoHint")}</span>
      </div>
      <div className="h-0.5 overflow-hidden rounded-full bg-[#3A3A42]">
        <div className="skipad-toast-countdown h-full bg-brand" />
      </div>
    </>
  );
}

function UndoneBody(props: { start: number; undoTo?: number }): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2">
        <Undo2 aria-hidden className="size-4 text-brand" />
        <span className="text-label font-semibold">{t("overlay.undone")}</span>
      </div>
      <span className="block text-overline text-[#C6C6CE]">
        {t("overlay.undoneBody", {
          time: formatClock(props.undoTo ?? props.start + 0.01)
        })}
      </span>
      <span className="block text-overline text-muted-foreground">{t("overlay.undoneNote")}</span>
    </>
  );
}

function InfoBody(props: { kind: Segment["kind"]; start: number; end: number }): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-[3px]" style={kindSwatchStyle(props.kind)} />
        <span className="text-label font-semibold">{kindLabel(props.kind)}</span>
        <span className="font-mono text-overline text-muted-foreground ml-auto">
          {formatClock(props.start)} – {formatClock(props.end)}
        </span>
      </div>
      <span className="block text-overline text-[#C6C6CE]">
        {t("overlay.infoBody", { kind: kindLabel(props.kind) })}
      </span>
    </>
  );
}
