import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  CircleAlert,
  Clock,
  FileQuestion,
  Pause,
  RefreshCw,
  Settings,
  ShieldCheck,
  SkipForward,
  ThumbsDown,
  TriangleAlert
} from "lucide-react";
import { formatClock } from "../../core/lib/time";
import { kindLabel } from "../../core/policy/kinds";
import { kindSwatchStyle, policyText } from "../../core/ui/kinds";
import {
  danmakuReason,
  type DanmakuReason,
  type UiPhase,
  type UiState
} from "../../core/ui/state";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { segmentKey } from "../../core/player/segment-skipper";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { ContentScriptIssue, PopupCommand } from "./use-popup-state";
import { t } from "../../core/i18n";

/** 状态名与状态点颜色只在这里定义一次，避免两个 switch 各写一套。 */
const PHASE_META: Record<UiPhase, { name: string; dot: string }> = {
  analyzing: { name: t("phase.analyzing"), dot: "bg-brand animate-pulse" },
  ready: { name: t("phase.ready"), dot: "bg-success" },
  no_ads: { name: t("phase.no_ads"), dot: "bg-success" },
  no_key: { name: t("phase.no_key"), dot: "bg-danger" },
  danmaku_only: { name: t("phase.danmaku_only"), dot: "bg-warning" },
  source_unavailable: { name: t("phase.source_unavailable"), dot: "bg-warning" },
  no_context: { name: t("phase.no_context"), dot: "bg-muted-foreground" },
  failed: { name: t("phase.failed"), dot: "bg-danger" },
  permission: { name: t("phase.permission"), dot: "bg-danger" },
  disabled: { name: t("phase.disabled"), dot: "bg-muted-foreground" },
  cancelled: { name: t("phase.cancelled"), dot: "bg-warning" }
};

/** 仅弹幕的四种来由各写各的文案，别把「字幕不属于本视频」说成「未登录」。 */
const DANMAKU_COPY: Record<DanmakuReason, { name: string; body: string }> = {
  not_logged_in: {
    name: t("popup.danmaku.notLoggedInName"),
    body: t("popup.danmaku.notLoggedInBody")
  },
  subtitle_foreign: {
    name: t("popup.danmaku.foreignName"),
    body: t("popup.danmaku.foreignBody")
  },
  subtitle_unreadable: {
    name: t("popup.danmaku.unreadableName"),
    body: t("popup.danmaku.unreadableBody")
  },
  subtitle_missing: {
    name: t("popup.danmaku.missingName"),
    body: t("popup.danmaku.missingBody")
  },
  unknown: {
    name: t("popup.danmaku.unknownName"),
    body: t("popup.danmaku.unknownBody")
  }
};

interface PopupBodyProps {
  phase: UiPhase;
  ui: UiState | null;
  issue: ContentScriptIssue;
  showList: boolean;
  onShowList: () => void;
  onCommand: PopupCommand;
  onOpenSettings: () => void;
}

/** 按状态选择卡片；分析中已有片段时仍然显示列表，避免界面跳来跳去。 */
export function PopupBody(props: PopupBodyProps): JSX.Element {
  const { phase, ui, issue, showList } = props;
  const segmentCount = ui?.segments.length ?? 0;

  if (issue && phase !== "no_key" && phase !== "permission") {
    return (
      <EmptyCard
        message={issue === "no_script" ? t("popup.issue.noScript") : t("popup.issue.unsupported")}
        hint={
          issue === "no_script"
            ? t("popup.issue.noScriptHint")
            : t("popup.issue.unsupportedHint")
        }
      />
    );
  }
  if (phase === "analyzing" && segmentCount === 0) {
    return (
      <AnalyzingCard
        progress={ui?.progress ?? null}
        onCancel={() => void props.onCommand("cancelAnalysis")}
      />
    );
  }
  // 仅弹幕模式点开「查看判定依据」后落到列表视图。
  const mainShowList =
    showList ||
    phase === "ready" ||
    phase === "no_ads" ||
    (phase === "analyzing" && segmentCount > 0);
  if (phase === "danmaku_only" && showList) {
    return <MainView ui={ui} showList={mainShowList} onCommand={props.onCommand} />;
  }
  const phaseView = PHASE_VIEWS[phase];
  if (phaseView) return phaseView(props);
  return <MainView ui={ui} showList={mainShowList} onCommand={props.onCommand} />;
}

/** 每个相位对应一张卡片；MainView 是兜底，不在这张表里。 */
const PHASE_VIEWS: Partial<Record<UiPhase, (props: PopupBodyProps) => JSX.Element>> = {
  no_key: (props) => (
    <NoKeyCard site={props.ui?.site ?? null} onOpenSettings={props.onOpenSettings} />
  ),
  danmaku_only: (props) => (
    <DanmakuCard
      reason={danmakuReason(props.ui?.warnings ?? [])}
      onOpenDetails={props.onShowList}
      canOpenDetails={(props.ui?.segments.length ?? 0) > 0}
    />
  ),
  source_unavailable: (props) => (
    <SourceUnavailableCard
      fetchFailed={props.ui?.warnings.includes("transcript_fetch_failed") ?? false}
      hasPlatformAd={props.ui?.platformAd != null}
      onRetry={() => void props.onCommand("reanalyze")}
    />
  ),
  no_context: (props) => (
    <NoContextCard
      site={props.ui?.site ?? null}
      hasPlatformAd={props.ui?.platformAd != null}
      onRetry={() => void props.onCommand("reanalyze")}
    />
  ),
  failed: (props) => (
    <FailedCard
      error={props.ui?.error ?? null}
      onRetry={() => void props.onCommand("reanalyze")}
    />
  ),
  permission: (props) => <PermissionCard onOpenSettings={props.onOpenSettings} />,
  cancelled: (props) => <CancelledCard onRetry={() => void props.onCommand("reanalyze")} />
};

/**
 * 字幕轨没通过校验时，状态条下面留一行说明。仅弹幕卡片已经有完整解释，
 * 这里不重复；有片段但字幕不可信时，用户仍然需要知道判定只用了弹幕。
 */
function SubtitleIncompleteNotice(props: { ui: UiState }): JSX.Element | null {
  if (props.ui.phase === "danmaku_only") return null;
  if (!props.ui.warnings.includes("subtitle_incomplete")) return null;
  return (
    <div className="flex flex-none items-start gap-2 border-b border-border bg-surface px-4 py-2 text-caption text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 flex-none" />
      <span>
        <span className="font-medium">{t("popup.subtitleUnreliable")}</span>
        {DANMAKU_COPY.subtitle_foreign.body}
      </span>
    </div>
  );
}

/** 结果里有分块失败：有片段时留在列表上方提示，没有片段时整卡进失败态。 */
function IncompleteNotice(props: { ui: UiState }): JSX.Element | null {
  if (!props.ui.incomplete) return null;
  return (
    <div className="flex flex-none items-start gap-2 border-b border-border bg-surface px-4 py-2 text-caption text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 flex-none" />
      <span>
        <span className="font-medium">{t("popup.incomplete")}</span>
        {t("popup.incompleteBody")}
      </span>
    </div>
  );
}

function SessionStatus(props: { ui: UiState }): JSX.Element {
  const { ui } = props;
  const meta = PHASE_META[ui.phase];
  const phaseName =
    ui.phase === "danmaku_only"
      ? DANMAKU_COPY[danmakuReason(ui.warnings)].name
      : ui.phase === "no_context" && ui.site === "youtube"
        ? t("popup.noContext.youtubeTitle")
        : meta.name;
  // 没有分析结果时不要显示「有字幕轨」：那会和「没读到字幕数据」自相矛盾。
  const modeText =
    ui.phase === "no_context" || ui.phase === "source_unavailable" || ui.phase === "failed"
      ? t("popup.mode.noAnalysis")
      : ui.mode === "danmaku"
        ? t("popup.mode.danmaku")
        : ui.mode === "full"
          ? t("popup.mode.full")
          : t("popup.mode.waiting");
  return (
    <>
      <div className="flex h-12 flex-none items-center gap-2 border-b border-border bg-surface px-4">
        <span aria-hidden className={`size-2 flex-none rounded-full ${meta.dot}`} />
        <span className="text-label font-medium">{phaseName}</span>
        <span className="text-caption text-muted-foreground grow">
          {ui.segments.length > 0
            ? t("popup.status.segments", { count: ui.segments.length, mode: modeText })
            : modeText}
        </span>
        {ui.progress && (
          <span className="font-mono text-overline text-brand-ink">
            {t("popup.status.progress", {
              done: ui.progress.done,
              total: ui.progress.total
            })}
          </span>
        )}
      </div>
      <div className="flex h-14 flex-none flex-col justify-center gap-0.5 border-b border-border px-4">
        <span className="truncate text-label font-medium">
          {ui.title || t("popup.status.untitled")}
        </span>
        <span className="text-overline text-muted-foreground">
          P{ui.page} · {formatClock(ui.durationSec)} ·{" "}
          {ui.cacheKey ? t("popup.status.cached") : t("popup.status.notCached")}
        </span>
      </div>
      <IncompleteNotice ui={ui} />
      <SubtitleIncompleteNotice ui={ui} />
      {ui.platformAd && (
        <PlatformAdStatus state={ui.platformAd} enabled={ui.platformAdEnabled} />
      )}
    </>
  );
}

/** 平台广告即时快进状态与视频内分析状态分开展示，避免混成一种「完成」。 */
function PlatformAdStatus(props: {
  state: NonNullable<UiState["platformAd"]>;
  enabled: boolean;
}): JSX.Element {
  const { state, enabled } = props;
  const text = !enabled
    ? t("popup.platformAd.disabled")
    : state.phase === "fast_forwarding"
      ? t("popup.platformAd.fastForwarding")
      : state.phase === "waiting"
        ? t("popup.platformAd.waiting")
        : state.phase === "given_up"
          ? t("popup.platformAd.givenUp")
          : state.attempts > 0
            ? t("popup.platformAd.attempts", { count: state.attempts })
            : t("popup.platformAd.none");
  return (
    <div className="flex h-8 flex-none items-center gap-2 border-b border-border bg-surface px-4">
      <span className="text-overline text-muted-foreground">{t("popup.platformAd.label")}</span>
      <span className="text-overline text-muted-foreground ml-auto">{text}</span>
    </div>
  );
}

interface TooltipPosition {
  left: number;
  top: number;
  width: number;
  placement: "top" | "bottom";
}

/** 原生 title 在扩展 Popup 里不显示，这里自己画一层可读的浮层。 */
function ReasonDetail(props: { text: string }): JSX.Element {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(rect.width || 300, window.innerWidth - 16);
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8)
    );
    setPosition({ left, top: rect.bottom + 6, width, placement: "bottom" });
  }, [open]);

  useLayoutEffect(() => {
    if (
      !open ||
      position?.placement !== "bottom" ||
      !tooltipRef.current ||
      !triggerRef.current
    ) {
      return;
    }
    const tooltip = tooltipRef.current.getBoundingClientRect();
    if (tooltip.bottom <= window.innerHeight - 8) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    setPosition({
      ...position,
      top: Math.max(8, trigger.top - tooltip.height - 6),
      placement: "top"
    });
  }, [open, position]);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        className="line-clamp-1 cursor-help text-overline text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {props.text}
      </span>
      {open &&
        position &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            style={{ left: position.left, top: position.top, width: position.width }}
            className="pointer-events-none fixed z-[100] whitespace-normal break-words rounded-md border border-border bg-popover px-2.5 py-2 text-overline leading-4 text-popover-foreground shadow-lg"
          >
            {props.text}
          </div>,
          document.body
        )}
    </>
  );
}

function SegmentList(props: { ui: UiState; onCommand: PopupCommand }): JSX.Element {
  const { ui, onCommand } = props;
  return (
    <>
      <div className="flex h-[26px] flex-none items-center bg-surface px-4">
        <span className="text-overline text-muted-foreground">{t("popup.list.title")}</span>
        <span className="text-overline text-muted-foreground ml-auto">{t("popup.list.sort")}</span>
      </div>
      {/*
       * 空结果提示不放进滚动区：滚动区没有最小高度时会被挤成零高，
       * 提示只剩半行。这里给它 48px 的最小高度，永远能完整显示。
       */}
      {ui.segments.length === 0 ? (
        <p className="min-h-12 grow px-4 py-4 text-caption text-muted-foreground">
          {t("popup.list.empty")}
        </p>
      ) : (
        <ScrollArea className="min-h-[120px] grow">
          {ui.segments.map((view) => {
            // 优先用视图自带的原始 key：裁剪块的起止已经变了，按起止算会找不到原片段。
            const key = view.key ?? segmentKey(view.segment);
            const time = `${formatClock(view.segment.start)} – ${formatClock(view.segment.end)}`;
            const detail = t("popup.detail.confidence", {
              confidence: view.segment.confidence.toFixed(2),
              policy: policyText(view.policy),
              reason: view.segment.reason || t("popup.detail.noReason")
            });
            return (
              <div
                key={key}
                className="flex gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <span
                  aria-hidden
                  className="w-1 flex-none rounded-[2px]"
                  style={kindSwatchStyle(view.segment.kind)}
                />
                <div className="flex min-w-0 grow flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-caption font-semibold">
                      {kindLabel(view.segment.kind)}
                    </span>
                    <span className="font-mono text-overline text-muted-foreground">
                      {formatClock(view.segment.start)} – {formatClock(view.segment.end)}
                    </span>
                    <span className="text-overline text-muted-foreground ml-auto">
                      {t("common.seconds", {
                        count: Math.round(view.segment.end - view.segment.start)
                      })}
                    </span>
                  </div>
                  <ReasonDetail text={detail} />
                  <div className="mt-0.5 flex gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={t("popup.aria.skipToEnd", {
                        kind: kindLabel(view.segment.kind),
                        time
                      })}
                      onClick={() => void onCommand("skipToEnd", { key })}
                    >
                      <SkipForward aria-hidden className="size-3" />
                      {t("popup.action.skipToEnd")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t("popup.aria.notAd", {
                        kind: kindLabel(view.segment.kind),
                        time
                      })}
                      onClick={() => void onCommand("markNotAd", { key })}
                    >
                      <ThumbsDown aria-hidden className="size-3" />
                      {t("popup.action.notAd")}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </ScrollArea>
      )}
    </>
  );
}

function BottomActions(props: { ui: UiState; onCommand: PopupCommand }): JSX.Element {
  const { ui, onCommand } = props;
  return (
    <footer className="flex flex-none flex-col gap-2 border-t border-border bg-surface px-4 py-3">
      <div className="flex gap-2">
        <Button variant="outline" className="grow" onClick={() => void onCommand("reanalyze")}>
          <RefreshCw aria-hidden />
          {t("common.reanalyze")}
        </Button>
        <Button className="grow" onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings aria-hidden />
          {t("popup.footer.openSettings")}
        </Button>
      </div>
      <span className="text-center text-overline text-muted-foreground">
        {t("popup.footer.stats", {
          count: ui.stats.skippedCount,
          seconds: Math.round(ui.stats.skippedSeconds),
          undos: ui.stats.undoCount
        })}
      </span>
    </footer>
  );
}

function MainView(props: {
  ui: UiState | null;
  showList: boolean;
  onCommand: PopupCommand;
}): JSX.Element {
  const { ui, showList, onCommand } = props;
  if (!ui) {
    return (
      <EmptyCard
        message={t("popup.empty.connecting")}
        hint={t("popup.empty.connectingHint")}
      />
    );
  }
  return (
    <>
      <SessionStatus ui={ui} />
      {showList && <SegmentList ui={ui} onCommand={onCommand} />}
      <BottomActions ui={ui} onCommand={onCommand} />
    </>
  );
}

function AnalyzingCard(props: {
  progress: UiState["progress"];
  onCancel: () => void;
}): JSX.Element {
  const percent =
    props.progress && props.progress.total > 0
      ? Math.round((props.progress.done / props.progress.total) * 100)
      : 8;
  return (
    <StateCard
      icon={<RefreshCw aria-hidden className="size-5 animate-spin text-brand" />}
      title={t("popup.analyzing.title")}
      badge="…"
      body={t("popup.analyzing.body")}
    >
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-caption text-muted-foreground">
        {props.progress
          ? t("popup.analyzing.progress", {
              done: props.progress.done,
              total: props.progress.total
            })
          : t("popup.analyzing.transcript")}
      </span>
      <Button variant="outline" size="sm" className="self-start" onClick={props.onCancel}>
        {t("popup.analyzing.cancel")}
      </Button>
    </StateCard>
  );
}

function NoKeyCard(props: { site: string | null; onOpenSettings: () => void }): JSX.Element {
  return (
    <StateCard
      icon={<CircleAlert aria-hidden className="size-5 text-danger" />}
      title={t("popup.noKey.title")}
      badge="!"
      body={t("popup.noKey.body")}
      alert={t("popup.noKey.alert")}
      alertTone="danger"
      note={
        props.site === "youtube"
          ? t("popup.noKey.noteYoutube")
          : t("popup.noKey.noteOther")
      }
    >
      <Button size="sm" className="self-start" onClick={props.onOpenSettings}>
        {t("popup.noKey.action")}
      </Button>
    </StateCard>
  );
}

function DanmakuCard(props: {
  reason: DanmakuReason;
  onOpenDetails: () => void;
  canOpenDetails: boolean;
}): JSX.Element {
  const copy = DANMAKU_COPY[props.reason];
  const loginHint =
    props.reason === "not_logged_in" ? t("popup.danmaku.loginHint") : "";
  return (
    <StateCard
      icon={<TriangleAlert aria-hidden className="size-5 text-warning" />}
      title={copy.name}
      badge="…"
      body={copy.body}
      alert={t("popup.danmaku.alert", { loginHint })}
      note={t("popup.danmaku.note")}
    >
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!props.canOpenDetails}
        onClick={props.onOpenDetails}
      >
        {t("popup.danmaku.details")}
      </Button>
    </StateCard>
  );
}

/**
 * 字幕和弹幕都没读到：这次分析没有可读内容，不能说成「仅弹幕」或「无广告」。
 * YouTube 没有弹幕，只说「没有字幕」，不要复用 B 站文案。
 */
function NoContextCard(props: {
  site: string | null;
  hasPlatformAd: boolean;
  onRetry: () => void;
}): JSX.Element {
  const youtube = props.site === "youtube";
  return (
    <StateCard
      icon={<FileQuestion aria-hidden className="size-5 text-muted-foreground" />}
      title={youtube ? t("popup.noContext.youtubeTitle") : t("popup.noContext.otherTitle")}
      badge="∅"
      body={
        youtube
          ? t("popup.noContext.youtubeBody")
          : t("popup.noContext.otherBody")
      }
      note={
        props.hasPlatformAd
          ? t("popup.noContext.platformNote")
          : t("popup.noContext.note")
      }
    >
      <Button variant="outline" size="sm" className="self-start" onClick={props.onRetry}>
        {t("common.reanalyze")}
      </Button>
    </StateCard>
  );
}

/**
 * 字幕数据没读到：可能是播放器桥不可用、播放器还没切到当前视频，或正文拉取失败。
 * 视频本身可能有字幕，文案不能写成「没有字幕」。
 */
function SourceUnavailableCard(props: {
  fetchFailed: boolean;
  hasPlatformAd: boolean;
  onRetry: () => void;
}): JSX.Element {
  return (
    <StateCard
      icon={<RefreshCw aria-hidden className="size-5 text-warning" />}
      title={
        props.fetchFailed
          ? t("popup.sourceFailed.title")
          : t("popup.sourceFailed.playerTitle")
      }
      badge="!"
      body={
        props.fetchFailed
          ? t("popup.sourceFailed.fetchBody")
          : t("popup.sourceFailed.playerBody")
      }
      note={
        props.hasPlatformAd
          ? t("popup.sourceFailed.platformNote")
          : t("popup.sourceFailed.note")
      }
    >
      <Button variant="outline" size="sm" className="self-start" onClick={props.onRetry}>
        {t("common.reanalyze")}
      </Button>
    </StateCard>
  );
}

function FailedCard(props: {
  error: UiState["error"];
  onRetry: () => void;
}): JSX.Element {
  const error = props.error;
  const statusText = error
    ? t("popup.failed.status", {
        status: error.status !== undefined ? `HTTP ${error.status}` : error.kind,
        elapsed: (error.elapsedMs / 1000).toFixed(1),
        count: error.newSegments
      })
    : t("popup.failed.noDetail");
  return (
    <StateCard
      icon={<CircleAlert aria-hidden className="size-5 text-danger" />}
      title={t("popup.failed.title")}
      badge="!"
      body={t("popup.failed.body")}
      alert={statusText}
      alertTone="danger"
      note={t("popup.failed.note")}
    >
      <Button variant="outline" size="sm" className="self-start" onClick={props.onRetry}>
        {t("popup.failed.retry")}
      </Button>
    </StateCard>
  );
}

function CancelledCard(props: { onRetry: () => void }): JSX.Element {
  return (
    <StateCard
      icon={<Pause aria-hidden className="size-5 text-warning" />}
      title={t("popup.cancelled.title")}
      badge="!"
      body={t("popup.cancelled.body")}
      note={t("popup.cancelled.note")}
    >
      <Button size="sm" className="self-start" variant="outline" onClick={props.onRetry}>
        {t("common.reanalyze")}
      </Button>
    </StateCard>
  );
}

function PermissionCard(props: { onOpenSettings: () => void }): JSX.Element {
  return (
    <StateCard
      icon={<ShieldCheck aria-hidden className="size-5 text-danger" />}
      title={t("popup.permission.title")}
      badge="!"
      body={t("popup.permission.body")}
      alert={t("popup.permission.alert")}
      alertTone="danger"
      note={t("popup.permission.note")}
    >
      <Button size="sm" className="self-start" onClick={props.onOpenSettings}>
        {t("popup.permission.action")}
      </Button>
    </StateCard>
  );
}

function StateCard(props: {
  icon: JSX.Element;
  title: string;
  badge: string;
  body: string;
  alert?: string;
  alertTone?: "info" | "danger" | "success";
  note?: string;
  children?: ReactNode;
}): JSX.Element {
  const tone = props.alertTone ?? "info";
  const toneClass =
    tone === "danger"
      ? "border-l-[3px] border-l-danger"
      : tone === "success"
        ? "border-l-[3px] border-l-success"
        : "border-l-[3px] border-l-warning";
  return (
    <section className="flex grow flex-col gap-2.5 overflow-hidden p-4">
      <div className="flex items-center gap-2 border-b border-border pb-2.5">
        {props.icon}
        <span className="text-body font-semibold">{props.title}</span>
        <Badge variant="outline" className="ml-auto font-mono text-overline">
          {props.badge}
        </Badge>
      </div>
      <p className="text-caption text-foreground">{props.body}</p>
      {props.alert && (
        <div className={`rounded-sm border border-border bg-surface px-2.5 py-2 text-overline ${toneClass}`}>
          {props.alert}
        </div>
      )}
      {props.children}
      {props.note && <span className="mt-auto text-caption text-muted-foreground">{props.note}</span>}
    </section>
  );
}

function EmptyCard(props: { message: string; hint: string }): JSX.Element {
  return (
    <section className="flex grow flex-col items-center justify-center gap-1.5 p-4 text-center">
      <Clock aria-hidden className="size-6 text-muted-foreground" />
      <span className="text-body font-medium">{props.message}</span>
      <span className="text-caption text-muted-foreground">{props.hint}</span>
    </section>
  );
}
