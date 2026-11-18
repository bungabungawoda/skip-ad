import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { videoKeyString } from "../lib/video-key";
import type { AnalysisResult } from "../analysis/types";
import type {
  AnalysisPartial,
  Segment,
  SiteAdapter,
  SegmentAnalyzer,
  VideoKey,
  OverlayAdapter
} from "../plugin/types";
import { errorText } from "../lib/error";
import { segmentKey } from "../player/segment-skipper";
import { evaluateSessionPolicy } from "../ui/session-policy";
import type { UiRequest, UiResponse } from "../ui/messages";
import { isSettingsChangedMessage, isUiRequest } from "../ui/messages";
import { createPlatformAdController, type PlatformAdController } from "../platform-ad/controller";
import {
  addIgnoredKey,
  createRuntimeCache,
  readIgnoredKeys,
  readRuntimeSettings
} from "../ports/runtime-client";
import {
  canApplyResult,
  shouldClearRun,
  shouldStartAnalysis,
  type RunSnapshot
} from "../ports/run-guard";
import type { SkipStats } from "../ui/state";
import { logInfo, logWarn } from "../lib/log";
import { t } from "../i18n";
import { BadgeReporter } from "./badge";
import { toUiError } from "./analysis-policy";
import { clearAnalysis, initialSession, type Session } from "./session-state";
import { SettingsBinding } from "./settings-binding";
import { SkipController } from "./skip-controller";
import { buildUiState } from "./snapshot";
import { CommandRouter, type CommandFailure } from "./command-router";

/**
 * 页面会话控制器：只负责会话身份、调度与对外接口。
 * 设置读写、跳过执行、快照拼装分别交给 SettingsBinding、SkipController、buildUiState。
 * 每次新 VideoKey 建新代次，旧代次结果一律丢弃。
 */

export interface SessionControllerCallbacks {
  /** 把快照写进界面 store（Popup 与进度条色块的数据源）。 */
  publish(): void;
  /** Toast 出口：跳过、撤销与信息提示；manual 区分手动跳与自动跳。 */
  showToast(segment: Segment, mode: ToastMode, options?: ToastOptions): void;
}

type ToastMode = "skipped" | "undone" | "info";

interface ToastOptions {
  /** 手动跳为 true；自动跳缺省。 */
  manual?: boolean;
  /** 实际跳到的结尾。相邻片段被并进同一次跳转时，它比 segment.end 更远。 */
  end?: number;
  /** 撤销后实际回到的播放位置。 */
  undoTo?: number;
}

interface OverlayMountHandlers {
  onUndo: (key: string | undefined) => void;
  onSkip: (key: string) => void;
  getVideo: () => HTMLVideoElement | null;
}

export interface SessionControllerOptions {
  adapter: SiteAdapter;
  /** 站点插件 id：每站开关按它取值。 */
  siteId: string;
  analyzer: SegmentAnalyzer | null;
  callbacks: SessionControllerCallbacks;
  /** 内容脚本本地统计（跳过/撤销次数），快照会把它带给 Popup。 */
  readStats?: () => SkipStats;
  /**
   * 把 Toast 与进度条色块挂到页面上的出口，由装配层注入。
   * 核心不直接依赖挂载实现与界面 store；不传时不挂浮层。
   */
  mountOverlay?: (
    ctx: ContentScriptContext,
    overlay: OverlayAdapter,
    handlers: OverlayMountHandlers
  ) => () => void;
}

interface RunHandle {
  token: number;
  controller: AbortController;
  startedAt: number;
  /** 发起这次分析时的视频标识；切视频后迟到的结果仍记在旧视频上。 */
  videoKey: string;
}

export class SessionController {
  private session: Session;
  private readonly adapter: SiteAdapter;
  private readonly analyzer: SegmentAnalyzer | null;
  private readonly callbacks: SessionControllerCallbacks;
  private readonly readStats: (() => SkipStats) | undefined;
  private readonly settings: SettingsBinding;
  private readonly skip: SkipController;
  private readonly badge: BadgeReporter;
  private readonly commands: CommandRouter;
  private readonly mountOverlayFn: SessionControllerOptions["mountOverlay"];
  private disposeUiListener: (() => void) | null = null;
  private platformAd: PlatformAdController | null = null;
  private disposeNavigation: (() => void) | null = null;
  private disposeOverlay: (() => void) | null = null;
  private pollTimer: number | null = null;
  private siteId: string;
  /** 已加载过「不是广告」标记的视频键，避免每次发布都读一遍。 */
  private ignoredLoadedFor: string | null = null;
  /** 本实例的页面标记：扩展重载后旧内容脚本靠它发现自己已被接管。 */
  private readonly instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private started = false;
  private active = true;

  constructor(options: SessionControllerOptions) {
    this.adapter = options.adapter;
    this.siteId = options.siteId;
    this.analyzer = options.analyzer;
    this.callbacks = options.callbacks;
    this.readStats = options.readStats;
    this.mountOverlayFn = options.mountOverlay;
    this.session = initialSession(window.location.href);
    this.settings = new SettingsBinding(options.siteId);
    this.skip = new SkipController({
      suspended: () => this.platformAd?.shouldSuspendSegments() ?? false,
      resolveSegment: (key) => this.findSegmentByKey(key),
      onAutoSkip: ({ segment, to }) => {
        // 落点可能跨过相邻的几段：Toast 与统计按实际跳到的位置算，
        // 撤销回到跳转发生前的实际位置。
        const end = Number((to - 0.05).toFixed(2));
        this.showToast(segment, "skipped", { end });
        this.onSkipRecorded(segment, end);
      },
      onAfterSeek: () => this.publish()
    });
    this.badge = new BadgeReporter({
      session: () => this.session,
      analysisEnabled: () => this.settings.analysisEnabled()
    });
    this.commands = new CommandRouter({
      skip: () => this.skip,
      publish: () => this.publish(),
      showToast: (segment, mode, options) => this.showToast(segment, mode, options),
      onSkipRecorded: (segment, skippedEnd) => this.onSkipRecorded(segment, skippedEnd),
      onUndoRecorded: () => this.onUndoRecorded(),
      findSegmentByKey: (key) => this.findSegmentByKey(key),
      markNotAd: (key) => this.markNotAdByKey(key),
      cancelAnalysis: () => this.cancelAnalysis(),
      reanalyze: () => this.reanalyze()
    });
  }

  /** 启动：平台广告观察最先启动（不依赖元数据、Key 与字幕），再注册消息、轮询与浮层。 */
  start(ctx: ContentScriptContext): void {
    // 扩展重新加载后旧内容脚本不会自动退出：在页面标记本实例，旧实例下一轮 tick 自己停掉。
    this.started = true;
    document.documentElement.dataset.skipadInstance = this.instanceId;
    const adAdapter = this.adapter.createPlatformAdController?.();
    if (adAdapter) {
      // 平台广告控制器先于分析启动；设置读到之前按关闭处理，避免默认全开误点。
      this.platformAd = createPlatformAdController(adAdapter, {
        canSkip: () => {
          const switches = this.settings.siteSwitches;
          return switches.enabled && switches.platformAdSkip;
        },
        onSkip: (seconds) => this.onPlatformAdSkipped(seconds)
      });
      this.platformAd.start();
    }
    void this.loadSettings();
    // SPA 导航事件优先，500ms 轮询作为 URL 变化兜底。
    this.disposeNavigation = this.adapter.observeNavigation?.(() => this.tick())?.dispose ?? null;
    this.listenForUiMessages();
    this.pollTimer = window.setInterval(() => this.tick(), 500);
    this.mountOverlay(ctx);
  }

  /** 内容脚本失效时停掉轮询、观察器与平台广告控制器，避免页面切换后残留。 */
  stop(): void {
    this.started = false;
    this.active = false;
    const session = this.session;
    session.runToken += 1;
    session.abort?.abort();
    session.abort = null;
    session.analyzing = false;
    session.progress = null;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.disposeUiListener?.();
    this.disposeUiListener = null;
    this.disposeNavigation?.();
    this.disposeNavigation = null;
    this.disposeOverlay?.();
    this.disposeOverlay = null;
    this.platformAd?.stop();
    this.platformAd = null;
    this.skip.dispose();
  }

  /** 读取设置并把站点开关、策略、Key 状态应用到当前会话。 */
  private async loadSettings(): Promise<void> {
    try {
      this.applySettings(await readRuntimeSettings());
      this.publish();
    } catch (error) {
      logWarn("读取运行时设置失败", errorText(error));
    }
  }

  private applySettings(settings: Awaited<ReturnType<typeof readRuntimeSettings>>): void {
    this.settings.apply(settings);
    this.session.policy = this.settings.policy;
    this.session.configured = this.settings.configured;
    if (this.settings.analysisEnabled()) this.session.nextAnalysisAt = 0;
    this.reevaluate();
    // 设置刚到时补一次平台广告观察，让开关生效不必等下一轮轮询。
    this.platformAd?.refresh();
  }

  private pageTitle(): string {
    return this.adapter.pageTitle?.() ?? (document.title ?? "").trim();
  }

  private findSegmentByKey(key: string | undefined): Segment | undefined {
    if (!key || !this.session.result) return undefined;
    return this.session.result.segments.find((segment) => segmentKey(segment) === key);
  }

  /** 按当前策略与「不是广告」标记重新计算展示视图与自动跳列表。 */
  private reevaluate(): void {
    const session = this.session;
    // 站点或分析开关关闭时不做任何判定，已有结果也不展示、不自动跳。
    const decision =
      this.settings.analysisEnabled() && session.result
        ? evaluateSessionPolicy({
            segments: session.result.segments,
            policy: session.policy,
            mode: session.result.mode,
            // 只用分析时定下的正片时长：播放器的 duration 在切换视频时会变，口径必须唯一。
            durationSec: session.result.durationSec,
            ignoredKeys: session.ignoredKeys
          })
        : null;
    session.views = decision?.views ?? [];
    session.auto = decision?.auto ?? [];
    this.skip.setAuto(session.auto);
    if (decision?.invalid) {
      // 判定结果自相矛盾时不执行也不展示，按分析失败处理，让 Popup 给出重试入口。
      this.session.error = {
        kind: "invalid_result",
        message: decision.invalid,
        elapsedMs: 0,
        newSegments: 0
      };
    }
  }

  /** 生成当前会话快照，Popup 通过 ui.getState 拉取。 */
  snapshot() {
    return buildUiState({
      session: this.session,
      siteId: this.siteId,
      platformAd: this.platformAd?.snapshot() ?? null,
      analysisEnabled: this.settings.analysisEnabled(),
      platformAdEnabled: this.settings.siteSwitches.platformAdSkip,
      pageTitle: this.pageTitle(),
      ...(this.readStats ? { readStats: this.readStats } : {})
    });
  }

  /** 把快照写进内容脚本内存 store，并同步工具栏角标。 */
  private publish(): void {
    this.callbacks.publish();
    this.badge.send();
  }

  isAnalyzing(): boolean {
    return this.session.analyzing;
  }

  showToast(segment: Segment, mode: ToastMode, options: ToastOptions = {}): void {
    this.callbacks.showToast(segment, mode, options);
  }

  /** 统计记录由宿主（stores）完成；控制器只负责时机。 */
  onSkipRecorded: (segment: Segment, skippedEnd?: number) => void = () => {};
  onUndoRecorded: () => void = () => {};
  onPlatformAdSkipped: (seconds?: number) => void = () => {};

  private async markNotAdByKey(key: string | undefined): Promise<boolean | void> {
    if (!key) return;
    this.session.ignoredKeys.add(key);
    this.reevaluate();
    this.publish();
    const video = this.session.result?.video;
    if (video) {
      void addIgnoredKey(videoKeyString(video), key);
    }
    logInfo(`已把片段标记为不是广告：${key}`);
  }

  /** 分析完成后按最终视频标识读取「不是广告」标记，重新分析不会丢。 */
  private async loadIgnoredKeys(video: VideoKey): Promise<void> {
    const key = videoKeyString(video);
    if (this.ignoredLoadedFor === key) return;
    this.ignoredLoadedFor = key;
    const keys = await readIgnoredKeys(key);
    const current = this.session.result?.video;
    // 读取期间切换了视频：这批标记不属于当前会话。
    if (!current || videoKeyString(current) !== key) return;
    this.session.ignoredKeys = new Set(keys);
    this.reevaluate();
    this.publish();
  }

  /** 当前会话的竞态快照；video 用 session 现值，调用方再比对发起时的那一个。 */
  private runSnapshot(): RunSnapshot {
    return {
      runToken: this.session.runToken,
      analyzing: this.session.analyzing,
      cancelled: this.session.cancelled,
      video: this.session.video
    };
  }

  private applyResult(result: AnalysisResult, startedAt: number): void {
    this.session.result = result;
    this.reevaluate();
    void this.loadIgnoredKeys(result.video);
    const llmFailed = result.warnings.find((warning) => warning.code === "llm_failed");
    if (llmFailed) {
      // 用警告码本身当错误类型：认证、限流、超时、网络失败的原因不同，不能一律写成 auth。
      this.session.error = {
        kind: llmFailed.code,
        message: llmFailed.message,
        elapsedMs: Date.now() - startedAt,
        newSegments: result.segments.length
      };
    }
    logInfo("分析完成", {
      mode: result.mode,
      segments: result.segments.length,
      auto: this.session.auto.length,
      warnings: result.warnings.map((warning) => warning.code)
    });
  }

  /** 一次分析的启动：检查前置条件、占用会话令牌、准备取消信号。 */
  private beginRun(video: HTMLVideoElement): RunHandle | null {
    const session = this.session;
    if (session.analyzing) return null;
    if (!this.analyzer) {
      if (!session.loggedNoAnalyzer) {
        session.loggedNoAnalyzer = true;
        logInfo("当前站点没有可用的分析器，跳过分析", this.siteId);
      }
      return null;
    }
    if (!this.settings.analysisEnabled()) return null;
    if (!session.videoKey) return null;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      if (!session.loggedInvalidDuration) {
        session.loggedInvalidDuration = true;
        logInfo("视频时长无效，暂不分析", { duration: video.duration });
      }
      return null;
    }
    // 平台广告期间 <video> 的时长与播放位置描述的是广告，不是正片：
    // 这时启动分析会把几十秒的广告时长当成整条视频，结果还会被缓存 5 分钟。
    // tick 每 500ms 一次，广告结束后自然会重新发起。
    if (this.platformAd?.shouldSuspendSegments()) return null;

    session.analyzing = true;
    session.cancelled = false;
    session.progress = { done: 0, total: 0 };
    session.error = null;
    session.mainElapsedMs = null;
    const startedAt = Date.now();
    const token = ++session.runToken;
    const videoKey = videoKeyString(session.videoKey);
    // 上一轮的取消信号先断掉，避免旧请求继续占用配额。
    session.abort?.abort();
    const controller = new AbortController();
    session.abort = controller;
    this.publish();
    return { token, controller, startedAt, videoKey };
  }

  /** 读设置并确认这次分析该不该继续；返回 false 时已把退避时间写好。 */
  private async prepareRun(session: Session, video: HTMLVideoElement, token: number): Promise<boolean> {
    const settings = await readRuntimeSettings();
    if (!canApplyResult(this.runSnapshot(), token, video)) return false;
    this.applySettings(settings);
    if (!this.settings.analysisEnabled()) {
      session.nextAnalysisAt = Date.now() + 30_000;
      return false;
    }
    if (!settings.analysisConfigured) {
      if (!session.loggedMissingConfig) {
        session.loggedMissingConfig = true;
        logInfo("还没有配置 LLM 或决策模型，暂不分析");
      }
      session.nextAnalysisAt = Date.now() + 30_000;
      return false;
    }
    logInfo("开始分析", session.videoKey?.videoId, session.videoKey?.partId);
    return true;
  }

  /**
   * 连续对话的增量结果要整表替换：模型可能改起点、改终点或删掉之前误判的片段。
   * 时长与证据形态跟着每轮一起下发，否则第一轮 partial 会把 durationSec 留成 0，
   * 覆盖率守卫会误判、整轮分析期间所有片段都进不了自动跳。
   */
  private mergePartial(
    session: Session,
    videoKey: VideoKey,
    partial: AnalysisPartial
  ): void {
    const existing = session.result;
    const durationSec = partial.durationSec ?? existing?.durationSec ?? 0;
    const mode = partial.mode ?? existing?.mode ?? "full";
    session.result = existing
      ? { ...existing, segments: partial.segments, durationSec, mode }
      : {
          videoKey: "",
          video: videoKey,
          mode,
          segments: partial.segments,
          warnings: [],
          durationSec
        };
  }

  /** 调分析器，把进度与增量结果写回会话；旧代次的回调一律丢弃。 */
  private async callAnalyzer(
    session: Session,
    video: HTMLVideoElement,
    run: RunHandle
  ): Promise<AnalysisResult> {
    const analyzer = this.analyzer;
    const videoKey = session.videoKey;
    if (!analyzer || !videoKey) throw new Error(t("ui.analysisUnavailable"));
    return analyzer.analyze({
      video: videoKey,
      currentTime: video.currentTime,
      signal: run.controller.signal,
      evidenceSignal: run.controller.signal,
      isCancelled: () => this.session !== session || session.runToken !== run.token,
      onProgress: (done, total) => {
        // 旧分析的进度不能写进切换后的新会话。
        if (this.session !== session || session.runToken !== run.token) return;
        session.progress = { done, total };
        this.publish();
      },
      onPartial: (partial) => {
        // 迟到的增量结果不追溯已播放区间：能写回当前会话才整表替换展示。
        if (!canApplyResult(this.runSnapshot(), run.token, video)) return;
        this.mergePartial(session, videoKey, partial);
        this.reevaluate();
        this.publish();
      }
    });
  }

  private handleRunFailure(error: unknown, run: RunHandle, video: HTMLVideoElement): void {
    // 切换视频复用同一 video 元素时，旧分析的失败不能写进新会话。
    if (!canApplyResult(this.runSnapshot(), run.token, video)) {
      logInfo("分析已取消或会话已过期，丢弃这次失败", { token: run.token });
      return;
    }
    const info = toUiError(error, Date.now() - run.startedAt);
    this.session.error = info;
    this.session.nextAnalysisAt = Number.POSITIVE_INFINITY;
    logWarn("分析失败", { kind: info.kind, message: info.message, elapsedMs: info.elapsedMs });
  }

  private settleRun(run: RunHandle): void {
    const session = this.session;
    if (shouldClearRun(this.runSnapshot(), run.token)) {
      session.analyzing = false;
      session.progress = null;
      if (session.abort === run.controller) session.abort = null;
    }
    this.publish();
  }

  /** 一次分析的主体：拿到结果就落库，过期代次的迟到结果按取消记账。 */
  private async performRun(
    session: Session,
    video: HTMLVideoElement,
    run: RunHandle
  ): Promise<void> {
    if (!(await this.prepareRun(session, video, run.token))) return;
    const result = await this.callAnalyzer(session, video, run);
    session.mainElapsedMs = Date.now() - run.startedAt;
    if (!canApplyResult(this.runSnapshot(), run.token, video)) {
      return;
    }
    this.applyResult(result, run.startedAt);
  }

  private async runAnalysis(video: HTMLVideoElement): Promise<void> {
    const run = this.beginRun(video);
    if (!run) return;
    try {
      // 没配置 Key、站点开关关闭时不算一次分析。
      await this.performRun(this.session, video, run);
    } catch (error) {
      this.handleRunFailure(error, run, video);
    } finally {
      this.settleRun(run);
    }
  }

  async handleCommand(request: Extract<UiRequest, { type: "ui.command" }>): Promise<void> {
    await this.commands.handle(request);
  }

  private cancelAnalysis(): void {
    const session = this.session;
    session.runToken += 1;
    session.cancelled = true;
    session.analyzing = false;
    session.progress = null;
    // 直接中断在途 LLM 请求，而不是等它跑完再丢结果。
    session.abort?.abort();
    session.abort = null;
    logInfo("已请求取消分析");
  }

  private async reanalyze(): Promise<CommandFailure | void> {
    const session = this.session;
    const video = session.video;
    if (!video || !this.active) return;
    const cacheKey = session.result?.videoKey;
    logInfo("重新分析", { cacheKey, videoId: session.videoKey?.videoId });
    session.abort?.abort();
    session.abort = null;
    // 旧分析的令牌立即作废，否则新一轮会因为 analyzing 为 true 直接返回。
    session.runToken += 1;
    // 清缓存期间占住 tick，避免还没删掉旧缓存就重新发起分析。
    session.analyzing = true;
    session.cancelled = false;
    session.nextAnalysisAt = 0;
    if (cacheKey) {
      const deleted = await createRuntimeCache().delete(cacheKey);
      if (!this.active) return;
      if (!deleted) {
        const message = t("ui.reanalyzeCacheFailed");
        logWarn("重新分析前清缓存失败，本次不启动新一轮", { cacheKey });
        // 保留旧结果与缓存键：下次点重新分析才不会绕过这次失败的删除。
        session.analyzing = false;
        session.nextAnalysisAt = Number.POSITIVE_INFINITY;
        session.error = {
          kind: "internal",
          message,
          elapsedMs: 0,
          newSegments: 0
        };
        this.publish();
        return { ok: false, message };
      }
    }
    clearAnalysis(session);
    this.skip.setAuto([]);
    session.analyzing = false;
    void this.runAnalysis(video);
  }

  private listenForUiMessages(): void {
    if (this.disposeUiListener) return;
    const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
      message,
      _sender,
      sendResponse
    ) => {
      if (isSettingsChangedMessage(message)) {
        void this.loadSettings();
        return false;
      }
      if (!isUiRequest(message)) return false;
      if (message.type === "ui.getState") {
        sendResponse({ ok: true, value: this.snapshot() } satisfies UiResponse);
        return false;
      }
      void this.handleCommand(message)
        .then(() => {
          sendResponse({ ok: true, value: this.snapshot() } satisfies UiResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: { kind: "internal", message: errorText(error) }
          } satisfies UiResponse);
        });
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    this.disposeUiListener = () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }

  private resolveVideoKey(href: string): VideoKey | null {
    try {
      return this.adapter.resolveVideo(new URL(href));
    } catch (error) {
      logWarn("解析当前地址失败，按非视频页处理", { href, error: errorText(error) });
      return null;
    }
  }

  /** 轮询入口：URL 变化重建会话，播放器替换时重绑，到点发起分析。 */
  tick(): void {
    // 页面已经被新实例接管：旧内容脚本必须停下，否则两个控制器会抢同一个播放器。
    if (this.started && document.documentElement.dataset.skipadInstance !== this.instanceId) {
      logInfo("页面已由新的内容脚本接管，停止旧实例");
      this.stop();
      return;
    }
    const href = window.location.href;
    const videoKey = this.resolveVideoKey(href);
    if (href !== this.session.href) {
      // 只看视频标识，不看整串地址：站点往地址栏加分享、来源或时间戳参数时，
      // 视频没变就不该中断在途分析或清掉已有结果。
      const sameVideo =
        videoKey != null &&
        this.session.videoKey != null &&
        videoKeyString(videoKey) === videoKeyString(this.session.videoKey);
      if (sameVideo) {
        this.session.href = href;
      } else {
        this.session.abort?.abort();
        this.session = initialSession(href, this.session);
        this.skip.reset();
        this.ignoredLoadedFor = null;
        this.publish();
      }
    }
    this.session.videoKey = videoKey ?? this.session.videoKey;
    this.session.page = Number(this.session.videoKey?.partId) || 1;
    const video = this.adapter.player.findVideo();
    if (!video) return;
    if (this.session.video !== video) {
      this.session.abort?.abort();
      this.session.abort = null;
      this.session.video = video;
      clearAnalysis(this.session);
      this.session.cancelled = false;
      this.ignoredLoadedFor = null;
      this.skip.bind(video);
      this.publish();
    }
    if (
      shouldStartAnalysis({
        analyzing: this.session.analyzing,
        cancelled: this.session.cancelled,
        resultPresent: this.session.result !== null,
        nextAnalysisAt: this.session.nextAnalysisAt,
        now: Date.now()
      })
    ) {
      void this.runAnalysis(video);
    }
  }

  private mountOverlay(ctx: ContentScriptContext): void {
    const overlay = this.adapter.overlay;
    if (!overlay) return;
    this.disposeOverlay =
      this.mountOverlayFn?.(ctx, overlay, {
        onUndo: (key) => this.commands.undo(key),
        onSkip: (key) => this.commands.skipToEnd(key),
        getVideo: () => this.skip.currentVideo
      }) ?? null;
  }
}
