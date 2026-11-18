/**
 * YouTube 平台广告的页面端口：广告状态 class、播放器定位、快进动作。
 *
 * 策略（真机验证结论）：
 * seek 优先——不动倍速与静音，时长与可 seek 区间就绪就把广告 seek 到片尾，
 * 纯 seek 实测 21–66ms 内 YouTube 结束广告。真机对照发现：先挂 16 倍速/静音
 * 再 seek 会触发 YouTube 把广告冻结暂停在片尾，收尾拖 8 秒以上，所以倍速
 * 只做兜底——seek 没机会（时长或 seekable 区间不可用且广告已在走）或已判失败
 * （被弹回、生效后拖着不收尾）时才挂 16 倍速静音（playbackRate 硬上限 16），
 * 播放器重置倍速就在 ratechange/volumechange 事件里即时重挂。
 * 兜底挂上后一旦重新出现 seek 机会，先恢复原倍速再 seek。
 * 点「跳过广告」按钮的旧路线已下线：content script 的 click() 产生
 * isTrusted=false 的事件，YouTube 播放器判为异常，永远不执行跳过。
 * 全部站点选择器只出现在本文件；选择器失效只降级平台广告快进，不影响字幕分析。
 */

import type { PlatformAdAction } from "../../core/platform-ad/types";
import { errorText } from "../../core/lib/error";
import { logWarn } from "../../core/lib/log";

/** 播放失败只报一次：这个分支每秒都可能走到，重复日志会刷屏。 */
let playFailureLogged = false;

const PLAYER_SELECTOR = "#movie_player";
const AD_SHOWING_CLASS = "ad-showing";
/** seek 目标离片尾的余量，避免停在最后一帧上。 */
const SEEK_END_MARGIN = 0.05;
/** seek 生效后允许的落点偏差；currentTime 比目标小得多视为被弹回。 */
const SEEK_BOUNCE_TOLERANCE = 1;
/** seek 生效但广告拖着不收尾：连续这么多个观察步就转倍速兜底。 */
const EFFECTIVE_TICKS_LIMIT = 3;
/** 时长未就绪时最多等到的播放位置：广告已走过它还拿不到 seek 机会就倍速兜底。 */
const SEEK_WAIT_CURRENT_TIME = 1;
/**
 * seek 的最低起点：媒体真正开播（真机实测 ct≤0.5 前的 seek 会被静默丢弃，
 * 广告反而被搅乱；所有 66ms 内生效的 seek 都发生在 ct>0.5）。
 */
const SEEK_MIN_CURRENT_TIME = 0.5;
/** 倍速兜底的播放速率：浏览器支持范围 0.0625–16，16 是硬上限。 */
const FALLBACK_PLAYBACK_RATE = 16;
/** 省下不到 1 秒的动作不值得记，也避免同一条广告被反复累计成零头。 */
const MIN_REPORTED_SECONDS = 1;

export function findPlayerContainer(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(PLAYER_SELECTOR);
}

export function isAdShowing(container: Element): boolean {
  return container.classList.contains(AD_SHOWING_CLASS);
}

/** 广告用的 video 元素；只在播放器容器内找，不从整页兜底，避免碰到正片视频。 */
function findAdVideo(container: Element): HTMLVideoElement | null {
  return container.querySelector("video");
}

/** 快进策略的运行状态：pod 内多条广告共用，广告结束后复位。 */
interface PlatformAdFastForwardState {
  /** seek 被判失败（弹回或生效后拖着不收尾）后为真：本条媒体纯倍速放完。 */
  seekBanned: boolean;
  /** 本条媒体是否已执行过 seek，配合 lastTarget 识别弹回。 */
  armed: boolean;
  /** seek 生效后广告仍连续在播的观察步数；超过上限转倍速兜底。 */
  effectiveTicks: number;
  /** 最近一次 seek 的目标位置。 */
  lastTarget: number | null;
  /** 最近一次观察到的媒体时长；pod 换广告时它变化，重新允许 seek。 */
  lastDur: number | null;
  /** 最近一次 seek 的时刻；用来区分「seek 被弹回」与「pod 换了一条同长度广告」。 */
  seekedAt: number | null;
  /** 倍速兜底是否已挂上；广告结束时按 prevRate/prevMuted 恢复。 */
  rateApplied: boolean;
  prevRate: number;
  prevMuted: boolean;
}

function createFastForwardState(): PlatformAdFastForwardState {
  return {
    seekBanned: false,
    armed: false,
    effectiveTicks: 0,
    lastTarget: null,
    lastDur: null,
    seekedAt: null,
    rateApplied: false,
    prevRate: 1,
    prevMuted: false
  };
}

function resetFastForwardState(state: PlatformAdFastForwardState): void {
  state.seekBanned = false;
  state.armed = false;
  state.effectiveTicks = 0;
  state.lastTarget = null;
  state.lastDur = null;
  state.seekedAt = null;
}

/** 广告结束或播放器不可用：恢复快进前的倍速与静音，复位快进状态。 */
function restoreAfterAd(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement | null
): void {
  if (state.rateApplied) {
    state.rateApplied = false;
    if (video) {
      video.playbackRate = state.prevRate || 1;
      video.muted = state.prevMuted;
    }
  }
  resetFastForwardState(state);
}

/** 撤掉倍速兜底（出现 seek 机会时先恢复自然状态再 seek，避免触发广告冻结）。 */
function unpin(state: PlatformAdFastForwardState, video: HTMLVideoElement): void {
  if (!state.rateApplied) return;
  state.rateApplied = false;
  video.playbackRate = state.prevRate || 1;
  video.muted = state.prevMuted;
}

/**
 * 挂倍速兜底。返回 true 表示本次是首次挂上（算一次动作）；
 * 之后把被播放器重置的倍速重新挂上是保持性动作，返回 false，不算新的一次跳过。
 */
function ensureRatePinned(state: PlatformAdFastForwardState, video: HTMLVideoElement): boolean {
  if (!state.rateApplied) {
    state.rateApplied = true;
    state.prevRate = video.playbackRate || 1;
    state.prevMuted = video.muted;
    video.playbackRate = FALLBACK_PLAYBACK_RATE;
    video.muted = true;
    return true;
  }
  if (video.playbackRate !== FALLBACK_PLAYBACK_RATE) video.playbackRate = FALLBACK_PLAYBACK_RATE;
  if (!video.muted) video.muted = true;
  return false;
}

/** seekable 区间是否覆盖目标位置；环境不提供 seekable 时按可 seek 处理。 */
function seekableCovers(video: HTMLVideoElement, target: number): boolean {
  const ranges = (video as HTMLVideoElement & { seekable?: unknown }).seekable;
  if (!ranges || typeof (ranges as TimeRanges).length !== "number") return true;
  try {
    const r = ranges as TimeRanges;
    for (let index = 0; index < r.length; index += 1) {
      if (r.start(index) <= target && r.end(index) >= target) return true;
    }
    return false;
  } catch (error) {
    // 这是唯一一个异常默认值直接影响播放动作的点：按可 seek 处理会让 seek 真的发出去。
    // 失败也只多花一轮观察步，下一轮会走倍速兑底，但排障时不能没有线索。
    logWarn("读取 seekable 区间失败，按可 seek 处理", errorText(error));
    return true;
  }
}

/** 单次动作的结果片段；各阶段各算各的，主函数把 acted 与 seconds 合并。 */
type StageAction = { acted: boolean; seconds?: number };

const NO_ACTION: StageAction = { acted: false };

/** seek 后这么久之内的回退是弹回；更久的回退说明换了下一条广告。 */
const REWIND_AS_NEW_AD_MS = 2_000;
/** 播放位置回到这个范围内算「从头开始播」，与 seek 目标差多少无关。 */
const REWIND_START_SECONDS = 1;

/**
 * 连续广告 pod：showingAd 一直为真，换下一条广告时时长变化，重新允许 seek。
 * 两条广告时长完全相同时 duration 不变，但新广告会从头播：播放位置回退到
 * 起点附近也算换了一条，否则上一条的 armed 会把新广告误判成 seek 被弹回。
 * 弹回与换广告都会回到片头，只能用时间区分：seek 后一个观察周期内回退是弹回，
 * 播了一会儿再回退说明上一条广告结束、pod 换了下一条同长度广告。
 */
function resetOnNewPodEntry(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement,
  finiteDur: number | null,
  now: number
): void {
  const rewoundToStart =
    state.armed &&
    video.currentTime <= REWIND_START_SECONDS &&
    state.seekedAt !== null &&
    now - state.seekedAt > REWIND_AS_NEW_AD_MS;
  if (
    finiteDur !== null &&
    ((state.lastDur !== null && finiteDur !== state.lastDur) || rewoundToStart)
  ) {
    state.seekBanned = false;
    state.armed = false;
    state.effectiveTicks = 0;
  }
  if (finiteDur !== null) state.lastDur = finiteDur;
}

/**
 * seek 优先：不碰倍速与静音（先挂倍速再 seek 会触发 YouTube 冻结广告，
 * 收尾拖 8 秒；纯 seek 几十毫秒结束）。兜底挂着时先恢复自然状态。
 * 媒体还没真正开播时不 seek（真机实测过早的 seek 会被静默丢弃）。
 */
function trySeekToEnd(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement,
  finiteDur: number | null,
  now: number
): StageAction {
  if (state.seekBanned || state.armed || finiteDur === null || finiteDur <= 0
    || video.currentTime <= SEEK_MIN_CURRENT_TIME) {
    return NO_ACTION;
  }
  const target = Math.max(0, finiteDur - SEEK_END_MARGIN);
  if (!seekableCovers(video, target)) return NO_ACTION;
  // 剩余时长必须在 seek 之前读：seek 之后 currentTime 已经到片尾。
  const remaining = Math.max(0, finiteDur - video.currentTime);
  unpin(state, video);
  video.currentTime = target;
  state.armed = true;
  state.lastTarget = target;
  state.seekedAt = now;
  return {
    acted: true,
    ...(remaining >= MIN_REPORTED_SECONDS ? { seconds: remaining } : {})
  };
}

/**
 * seek 已生效的收尾观察：弹回转倍速兜底；拖着不收尾连续多个观察步也转兜底。
 * YouTube 冻结广告时会把视频暂停在片尾，推一下 play() 让 ended 走收尾。
 */
function observeSeekOutcome(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement
): void {
  if (!state.armed || state.lastTarget === null) return;
  if (video.currentTime < state.lastTarget - SEEK_BOUNCE_TOLERANCE) {
    // seek 被弹回：本条媒体不再尝试 seek，转倍速兜底。
    state.seekBanned = true;
  } else if (Math.abs(video.currentTime - state.lastTarget) <= SEEK_BOUNCE_TOLERANCE) {
    state.effectiveTicks += 1;
    if (state.effectiveTicks >= EFFECTIVE_TICKS_LIMIT) state.seekBanned = true;
    if (video.paused) {
      // 推播放失败可接受：下一个观察步会再推；这里静默是因为它每秒都可能发生，记日志只会刷屏。
      void video.play()?.catch?.((error: unknown) => {
        if (playFailureLogged) return;
        playFailureLogged = true;
        logWarn("平台广告快进后恢复播放失败", errorText(error));
      });
    }
  }
}

/**
 * 倍速兜底：seek 已判失败，或 seek 一直没机会而广告已在走。
 * 已 seek（armed）时不在此挂兜底：生效后的收尾拖延由 observeSeekOutcome 处理。
 */
function applyRateFallback(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement,
  finiteDur: number | null
): StageAction {
  const seekPossible = !state.armed && !state.seekBanned
    && finiteDur !== null && finiteDur > 0
    && video.currentTime > SEEK_MIN_CURRENT_TIME
    && seekableCovers(video, Math.max(0, finiteDur - SEEK_END_MARGIN));
  if (state.seekBanned) {
    // seek 已经报过一次秒数，这里只挂倍速，不再重复计算，免得同一条广告记两遍。
    return { acted: ensureRatePinned(state, video) };
  }
  if (seekPossible || state.armed || video.currentTime <= SEEK_WAIT_CURRENT_TIME) {
    return NO_ACTION;
  }
  if (!ensureRatePinned(state, video)) return NO_ACTION;
  // 16 倍速下用户只等了剩余时长的 1/16，省下的是其余部分。
  const remaining = finiteDur !== null ? Math.max(0, finiteDur - video.currentTime) : 0;
  const saved = (remaining * (FALLBACK_PLAYBACK_RATE - 1)) / FALLBACK_PLAYBACK_RATE;
  return {
    acted: true,
    ...(saved >= MIN_REPORTED_SECONDS ? { seconds: saved } : {})
  };
}

/**
 * 快进一步；返回是否执行了动作（seek 或首次挂倍速），以及这次动作省下的秒数。
 * 无可执行动作（时长未就绪、区间不覆盖、已 seek 到片尾、倍速维护）返回 acted=false。
 * 分四个阶段：pod 换条复位 → seek → seek 收尾观察 → 倍速兜底。
 */
function advancePlatformAdFastForward(
  state: PlatformAdFastForwardState,
  video: HTMLVideoElement | null,
  adShowing: boolean,
  now: number = Date.now()
): PlatformAdAction {
  if (!adShowing) {
    restoreAfterAd(state, video);
    return { acted: false };
  }
  if (!video) return { acted: false };

  const dur = video.duration;
  const finiteDur = Number.isFinite(dur) ? dur : null;

  resetOnNewPodEntry(state, video, finiteDur, now);
  const seek = trySeekToEnd(state, video, finiteDur, now);
  observeSeekOutcome(state, video);
  const fallback = applyRateFallback(state, video, finiteDur);

  const acted = seek.acted || fallback.acted;
  const seconds = seek.seconds ?? fallback.seconds;
  return { acted, ...(seconds !== undefined ? { seconds } : {}) };
}

/** 给站点适配器用的有状态快进器：observe 只做恢复，快进动作由核心状态机驱动。 */
export function createPlatformAdFastForward() {
  const state = createFastForwardState();
  return {
    /** 广告不在播时调用：恢复原倍速并复位。可重复调用，之后是空操作。 */
    restore(container: Element | null): void {
      restoreAfterAd(state, container ? findAdVideo(container) : null);
    },
    /**
     * 保持性维护：倍速兜底已挂上时，把被播放器重置的倍速/静音立即重挂。
     * 由 ratechange/volumechange 事件驱动（播放器重置会触发这两个事件），
     * 比轮询快得多；倍速未挂上时不做任何事（挂上只走状态机的动作路径）。
     */
    maintain(container: Element): void {
      if (!state.rateApplied || !isAdShowing(container)) return;
      const video = findAdVideo(container);
      if (video) ensureRatePinned(state, video);
    },
    /** 广告在播时由核心状态机调用；返回是否执行了动作与省下的秒数。 */
    step(container: Element): PlatformAdAction {
      return advancePlatformAdFastForward(
        state,
        findAdVideo(container),
        isAdShowing(container),
        Date.now()
      );
    }
  };
}
