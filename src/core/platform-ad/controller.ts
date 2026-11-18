import type {
  PlatformAdAction,
  PlatformAdAdapter,
  PlatformAdObservation,
  PlatformAdPhase,
  PlatformAdSnapshot
} from "./types";
import { errorText } from "../lib/error";
import { logInfo, logWarn } from "../lib/log";

/**
 * 平台广告状态机：无广告 → 快进中 → 等待可执行动作 → 快进次数用尽 → 无广告。
 *
 * 只依赖 PlatformAdAdapter 的观察与快进端口，不接触 LLM、Key、字幕或视频元数据；
 * 会话控制器在分析启动之前启动它，无 Key、无字幕、分析取消都不影响。
 * 快进条件全部满足才执行：状态可读、广告在播、本次广告出现期间没有已执行或进行中的
 * 动作、未超出有界重试上限。广告结束（showingAd 从真变假）后再次出现广告，视为新的
 * 出现次数；连续广告 pod 期间 showingAd 一直为真，快进次数预算要覆盖整个 pod。
 */

interface PlatformAdControllerOptions {
  /** 每次成功快进后回调省下的秒数；不影响状态机。 */
  onSkip?: (seconds?: number) => void;
  /** 快进后的验证窗口毫秒数；窗口内不重复动作。 */
  settleMs?: number;
  /** 单次广告出现期间的最大快进次数（有界重试，含 pod 内多条广告）。 */
  maxAttempts?: number;
  now?: () => number;
  /** 外部快进门：返回 false 时保持观察但不动作（如用户关闭了平台广告开关）。 */
  canSkip?: () => boolean;
}

export interface PlatformAdController {
  /** 启动 DOM 观察（播放器容器 MutationObserver + 低频轮询兜底）。 */
  start(): void;
  stop(): void;
  /** 执行一次观察与状态机推进；测试与低频兜底共用。 */
  refresh(): void;
  /** 正片片段跳过是否应暂停：广告中或状态未知（duration/currentTime 可能描述广告）。 */
  shouldSuspendSegments(): boolean;
  snapshot(): PlatformAdSnapshot;
}

export interface PlatformAdState {
  phase: PlatformAdPhase;
  attempts: number;
  appearance: number;
  lastActionAt: number | null;
  /** 观察到上一次广告在播；用于检测广告结束、统计出现次数。 */
  sawAd: boolean;
}

const SETTLE_MS_DEFAULT = 300;
const MAX_ATTEMPTS_DEFAULT = 5;
const POLL_INTERVAL_MS = 1_000;

function initialState(): PlatformAdState {
  return {
    phase: "no_ad",
    attempts: 0,
    appearance: 0,
    lastActionAt: null,
    sawAd: false
  };
}

/**
 * 状态机一步：输入观察结果与当前时间，输出是否执行了快进动作。
 * 省下的秒数只由真正生效的那次动作给出；同一条广告后续的兜底动作不会再给。
 */
export function advancePlatformAd(
  state: PlatformAdState,
  observation: PlatformAdObservation | null,
  now: number,
  options: {
    settleMs: number;
    maxAttempts: number;
    fastForward: () => PlatformAdAction;
  }
): { state: PlatformAdState; acted: boolean; seconds?: number } {
  const next: PlatformAdState = { ...state };

  if (observation === null) {
    // 状态未知：保持当前相位，不动作。播放器可能正在加载或已被替换。
    return { state: next, acted: false };
  }

  if (!observation.showingAd) {
    if (next.sawAd) {
      logInfo("平台广告已结束", { appearance: next.appearance, attempts: next.attempts });
    }
    next.phase = "no_ad";
    next.sawAd = false;
    next.attempts = 0;
    next.lastActionAt = null;
    return { state: next, acted: false };
  }

  if (!next.sawAd) {
    // 新的一次广告出现：动作次数与验证状态全部重置。
    next.appearance += 1;
    next.attempts = 0;
    next.lastActionAt = null;
    next.sawAd = true;
  }

  // 验证窗口内：上一次快进还在等结果（广告通常几十毫秒内结束），不重复动作。
  if (next.lastActionAt !== null && now - next.lastActionAt < options.settleMs) {
    next.phase = "fast_forwarding";
    return { state: next, acted: false };
  }

  if (next.attempts >= options.maxAttempts) {
    // 有界重试用尽：本条广告出现期间不再动作，只记录诊断，不阻塞播放。
    next.phase = "given_up";
    return { state: next, acted: false };
  }

  const action = options.fastForward();
  if (action.acted) {
    next.attempts += 1;
    next.lastActionAt = now;
    next.phase = "fast_forwarding";
    logInfo("快进平台广告", { appearance: next.appearance, attempt: next.attempts });
  } else {
    // 眼下无可执行动作（如时长未就绪、倍速已挂上）：等下一轮观察，不烧次数。
    next.phase = "waiting";
  }
  return {
    state: next,
    acted: action.acted,
    ...(action.seconds !== undefined ? { seconds: action.seconds } : {})
  };
}

export function createPlatformAdController(
  adapter: PlatformAdAdapter,
  options: PlatformAdControllerOptions = {}
): PlatformAdController {
  const settleMs = options.settleMs ?? SETTLE_MS_DEFAULT;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
  const now = options.now ?? Date.now;

  let state = initialState();
  let container: Element | null = null;
  let mutationObserver: MutationObserver | null = null;
  let pollTimer: number | null = null;
  let started = false;
  /** 最近一次成功观察；timeupdate 每秒多次调用，不能每次都查 DOM。 */
  let lastObservation: PlatformAdObservation | null = null;

  function rebindContainer(): void {
    const latest = adapter.container();
    if (latest === container) return;
    // 播放器被替换：断开旧观察，状态机回到无广告，重新绑定新容器。
    mutationObserver?.disconnect();
    mutationObserver = null;
    container = latest;
    state = initialState();
    if (container && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => refresh());
      // 只盯容器自身的 class：广告状态就是容器上的 ad-showing。
      // 观察整棵子树会让播放广告观察按帧触发——进度条、倒计时、缩略图每次变
      // 都会改属性或子节点，而它们对「现在是不是广告」没有任何影响。
      // 容器被站点换掉时由 1 秒轮询兜底重新绑定。
      mutationObserver.observe(container, { attributes: true, attributeFilter: ["class"] });
      logInfo("平台广告观察已绑定播放器容器");
    }
  }

  function refresh(): void {
    try {
      rebindContainer();
      const observation = adapter.observe();
      lastObservation = observation;
      const result = advancePlatformAd(state, observation, now(), {
        settleMs,
        maxAttempts,
        fastForward: () => ((options.canSkip?.() ?? true) ? adapter.fastForward() : { acted: false })
      });
      state = result.state;
      if (result.acted) {
        options.onSkip?.(result.seconds);
      }
    } catch (error) {
      // 观察失败只降级本能力：不动作、不阻塞播放；状态按未知处理，正片片段暂停。
      lastObservation = null;
      logWarn("平台广告观察失败", errorText(error));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      refresh();
      if (typeof window !== "undefined") {
        pollTimer = window.setInterval(refresh, POLL_INTERVAL_MS);
      }
    },
    stop() {
      started = false;
      adapter.dispose?.();
      mutationObserver?.disconnect();
      mutationObserver = null;
      if (pollTimer !== null && typeof window !== "undefined") {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    },
    refresh,
    shouldSuspendSegments() {
      // 广告中或状态未知（播放器缺失、被替换的间隙）都暂停正片片段执行。
      // 读最近一次观察结果，不在每次 timeupdate 里查 DOM。
      return lastObservation?.showingAd !== false;
    },
    snapshot() {
      return {
        phase: state.phase,
        attempts: state.attempts,
        appearance: state.appearance
      };
    }
  };
}
