import type { Segment } from "../plugin/types";
import {
  createSkipState,
  observePlayback,
  segmentKey,
  toSkipSegment,
  undoSkip,
  type SkipSegment,
  type SkipState,
  type SkipStep
} from "../player/segment-skipper";
import { logInfo, logWarn } from "../lib/log";

/** 跳转后多久确认播放器真的动了；多次重试覆盖慢速 seek。 */
const SKIP_VERIFY_MS = 400;
const SKIP_VERIFY_ATTEMPTS = 3;
/** 播放位置离目标不超过这个距离就算跳转成功：播放中 400ms 会往前走一点。 */
const SKIP_VERIFY_TOLERANCE_SECONDS = 2;

function withoutKey(map: Record<string, true>, key: string): Record<string, true> {
  const next = { ...map };
  delete next[key];
  return next;
}

interface AutoSkipReport {
  /** 触发这次跳转的第一个片段：撤销回到跳转前记录的位置。 */
  segment: Segment;
  /** 实际落点。相邻片段被并进同一次跳转时，它比 segment.end 更远。 */
  to: number;
}

interface SkipControllerOptions {
  /** 平台广告期间（或状态未知时）暂停正片片段执行。 */
  suspended: () => boolean;
  /** 按 key 找回完整片段，用于 Toast 与统计。 */
  resolveSegment: (key: string) => Segment | undefined;
  /** 自动跳发生后的回调：Toast、统计。 */
  onAutoSkip: (report: AutoSkipReport) => void;
  /** 跳转或撤销改写了播放位置后刷新快照。 */
  onAfterSeek: () => void;
}

/**
 * 跳过引擎：绑定播放器、维护 lastTime/guard/suppressed 状态、执行自动跳与手动跳。
 * 只负责播放位置与跳过状态，Toast 与统计通过回调交给会话层。
 */
export class SkipController {
  private state: SkipState = createSkipState();
  private video: HTMLVideoElement | null = null;
  private auto: SkipSegment[] = [];
  /** 每个片段最近一次跳转前的实际播放位置；撤销直接回到这里。 */
  private readonly jumpFrom = new Map<string, number>();
  /** 已绑定的播放器与监听器：dispose 时要能逐个摘掉，避免旧内容脚本残留。 */
  private readonly bound = new Map<HTMLVideoElement, Array<[string, () => void]>>();

  constructor(private readonly options: SkipControllerOptions) {}

  get currentState(): SkipState {
    return this.state;
  }

  get currentVideo(): HTMLVideoElement | null {
    return this.video;
  }

  setAuto(segments: SkipSegment[]): void {
    this.auto = segments;
  }

  /** 绑定新播放器：已绑过的元素不重复加监听，跳过状态按当前播放位置重建。 */
  bind(video: HTMLVideoElement): void {
    const changed = this.video !== video;
    this.video = video;
    this.state = createSkipState(video.currentTime);
    if (changed) this.jumpFrom.clear();
    if (this.bound.has(video)) return;
    const handlers: Array<[string, () => void]> = [
      ["timeupdate", () => this.handleTimeupdate(video)],
      ["seeked", () => this.syncLastTime(video)],
      ["play", () => undefined],
      ["pause", () => this.recordPausePosition(video)]
    ];
    for (const [type, handler] of handlers) video.addEventListener(type, handler);
    this.bound.set(video, handlers);
    // 站点换掉播放器元素时摘掉旧元素的监听：否则旧 <video> 会被这个 Map
    // 一直持有（连同解码缓冲一起留在内存里），监听器也还在空跑。
    for (const [other, staleHandlers] of this.bound) {
      if (other === video) continue;
      for (const [type, handler] of staleHandlers) other.removeEventListener(type, handler);
      this.bound.delete(other);
    }
  }

  /** 播放器被替换：摘掉旧监听、清掉引用与跳过状态，下一次 tick 重新绑定。 */
  reset(): void {
    this.detach();
    this.video = null;
    this.auto = [];
    this.state = createSkipState();
    this.jumpFrom.clear();
  }

  /** 内容脚本失效：停掉所有播放器监听，避免旧实例继续 seek 同一个播放器。 */
  dispose(): void {
    this.reset();
  }

  private detach(): void {
    for (const [video, handlers] of this.bound) {
      for (const [type, handler] of handlers) video.removeEventListener(type, handler);
    }
    this.bound.clear();
  }

  /** 手动跳：Popup 或进度条胶囊主动越过某个片段。 */
  manualSkip(segment: Segment): boolean {
    const video = this.video;
    if (!video) return false;
    const to = Math.min(video.duration, segment.end + 0.05);
    if (!Number.isFinite(to)) return false;
    if (Number.isFinite(video.currentTime)) {
      this.jumpFrom.set(segmentKey(segment), video.currentTime);
    }
    video.currentTime = to;
    this.state = {
      ...this.state,
      lastTime: to,
      guardUntil: Date.now() + 1_000,
      skipped: { ...this.state.skipped, [segmentKey(segment)]: true }
    };
    return true;
  }

  /** 撤销：回到这次跳转发生前的播放位置；返回落点，没有记录时返回 null。 */
  undo(segment: Segment): number | null {
    const video = this.video;
    if (!video) return null;
    const key = segmentKey(segment);
    const from = this.jumpFrom.get(key);
    if (from === undefined) return null;
    const step = undoSkip(this.state, toSkipSegment(segment), Date.now(), from);
    this.state = step.state;
    this.jumpFrom.delete(key);
    if (step.action.type !== "seek") return null;
    video.currentTime = step.action.to;
    return step.action.to;
  }

  private syncLastTime(video: HTMLVideoElement): void {
    if (this.video === video) {
      this.state = { ...this.state, lastTime: video.currentTime };
    }
  }

  private recordPausePosition(video: HTMLVideoElement): void {
    if (this.video !== video) return;
    this.state = {
      ...this.state,
      lastTime: Math.min(this.state.lastTime, video.currentTime)
    };
  }

  private handleTimeupdate(video: HTMLVideoElement): void {
    if (this.video !== video || this.auto.length === 0) {
      this.syncLastTime(video);
      return;
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const step = this.observe(video);
    this.state = step.state;
    if (step.action.type === "seek" && step.action.reason === "skip") {
      this.performSkip(step.action, video);
    }
  }

  private observe(video: HTMLVideoElement) {
    return observePlayback(
      this.state,
      {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        seeking: video.seeking,
        suspended: this.options.suspended(),
        now: Date.now()
      },
      this.auto
    );
  }

  private performSkip(action: Extract<SkipStep["action"], { type: "seek" }>, video: HTMLVideoElement): void {
    const key = action.segment.key;
    const segment = this.options.resolveSegment(key);
    const from = video.currentTime;
    // 先跳，再确认播放器真的接受了这次跳转，最后才显示「已跳过」。
    // 反过来做会出现「提示说跳过了、画面没动」，而且片段被永久标记成已跳。
    video.currentTime = action.to;
    const verify = (attempt: number): void => {
      if (this.video !== video) return;
      if (Math.abs(video.currentTime - action.to) <= SKIP_VERIFY_TOLERANCE_SECONDS) {
        if (Number.isFinite(from)) this.jumpFrom.set(key, from);
        if (segment) this.options.onAutoSkip({ segment, to: action.to });
        logInfo("跳过片段", {
          key,
          kind: segment?.kind ?? "unknown",
          policy: "auto",
          confidence: segment?.confidence ?? null,
          from: action.segment.start,
          to: action.to
        });
        this.options.onAfterSeek();
        return;
      }
      // 还在 seek 途中就再等一轮；位置被播放器弹回去才算失败。
      if (video.seeking && attempt + 1 < SKIP_VERIFY_ATTEMPTS) {
        window.setTimeout(() => verify(attempt + 1), SKIP_VERIFY_MS);
        return;
      }
      // 本次跳转把相邻几段一起并了进来：回滚要按整组清，
      // 只清第一段会让后面那几段永久停在「已跳过」，再也不会触发。
      let skipped = this.state.skipped;
      for (const skippedKey of action.keys) {
        skipped = withoutKey(skipped, skippedKey);
      }
      this.state = {
        ...this.state,
        lastTime: video.currentTime,
        skipped
      };
      logWarn(
        "跳转没有生效，已撤销跳过标记",
        `key=${key} · to=${action.to.toFixed(2)} · current=${video.currentTime.toFixed(2)}`
      );
    };
    window.setTimeout(() => verify(0), SKIP_VERIFY_MS);
  }
}
