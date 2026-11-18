import type { PlatformAdSnapshot } from "../platform-ad/types";
import { derivePhase, emptyUiState, type SkipStats, type UiState } from "../ui/state";
import { videoKeyString } from "../lib/video-key";
import { hasIncompleteWarnings } from "../analysis/completeness";
import type { Session } from "./session-state";

interface SnapshotInput {
  session: Session;
  siteId: string;
  platformAd: PlatformAdSnapshot | null;
  /** 站点分析开关；关闭时相位是 disabled。 */
  analysisEnabled?: boolean;
  /** 平台广告开关；关闭时卡片显示「已关闭」。 */
  platformAdEnabled?: boolean;
  pageTitle: string;
  readStats?: () => SkipStats;
}

function applyVideoState(state: UiState, input: SnapshotInput): void {
  const { session } = input;
  const video = session.video;
  state.site = input.siteId;
  state.page = session.page;
  state.title = input.pageTitle;
  state.videoId = session.result?.video.videoId ?? session.videoKey?.videoId ?? null;
  const finalKey = session.result?.video ?? session.videoKey;
  state.videoKey = finalKey ? videoKeyString(finalKey) : null;
  state.durationSec =
    session.result?.durationSec ??
    (video && Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0);
  state.currentTime = video ? Math.max(0, video.currentTime) : 0;
  state.mode = session.result?.mode ?? null;
  state.cacheKey = session.result?.videoKey ?? null;
  state.cancelled = session.cancelled;
}

function applyResultState(state: UiState, session: Session): void {
  state.progress = session.progress;
  state.error = session.error;
  state.warnings = session.result?.warnings.map((warning) => warning.code) ?? [];
  state.segments = session.views;
  state.incomplete = session.result ? hasIncompleteWarnings(session.result.warnings) : false;
}

function applyPhase(state: UiState, session: Session): void {
  state.phase = derivePhase({
    analyzing: session.analyzing,
    configured: session.configured,
    result: session.result,
    error: session.error,
    visibleSegments: session.views.length,
    incomplete: state.incomplete,
    analysisEnabled: state.analysisEnabled,
    cancelled: state.cancelled
  });
}

/** 把会话状态拼成 Popup 读取的完整快照；只做展示，不改会话。 */
export function buildUiState(input: SnapshotInput): UiState {
  const { session } = input;
  const state = emptyUiState(session.href);
  applyVideoState(state, input);
  state.platformAd = input.platformAd;
  state.analysisEnabled = input.analysisEnabled ?? true;
  state.platformAdEnabled = input.platformAdEnabled ?? true;
  applyResultState(state, session);
  if (input.readStats) state.stats = { ...input.readStats() };
  applyPhase(state, session);
  return state;
}
