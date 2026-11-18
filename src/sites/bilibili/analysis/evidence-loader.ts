/**
 * 哔哩哔哩证据取数：播放器信息、字幕轨、弹幕、信号集合。
 *
 * 判定方式有两套（连续对话与决策模型），取数只有一套：
 * 串轨校验、登录态降级、时长兜底都在这里做一次。
 */

import type { AnalysisWarning } from "../../../core/analysis/types";
import type {
  AnalysisMode,
  DanmakuData,
  DanmakuItem,
  PlayerInfo,
  SubtitleCue,
  VideoInfo
} from "../types";
import type { BiliClient } from "../api/client";
import {
  lastCueEnd,
  pickSubtitleTrack,
  subtitleOutrunsVideo
} from "../api/subtitle";
import { buildSignals, type SignalSet } from "./signals";
import { errorText } from "../../../core/lib/error";
import { logWarn } from "../../../core/lib/log";

/** 取证据只需要站点客户端和取消信号；分析器把判定方式换掉时不用再伪造 LLM。 */
interface EvidenceDeps {
  client: BiliClient;
  signal?: AbortSignal;
}

interface LoadedEvidence {
  video: VideoInfo;
  mode: AnalysisMode;
  cues: SubtitleCue[];
  warnings: AnalysisWarning[];
  hasSubtitleTrack: boolean;
  /** 有轨道但正文为空；缓存复用按「没有可用字幕正文」处理。 */
  subtitleBodyEmpty: boolean;
}

export interface CollectedData extends LoadedEvidence {
  danmaku: DanmakuData;
  signals: SignalSet;
}

const EMPTY_PLAYER: PlayerInfo = { isLogin: false, subtitles: [], chapters: [] };

export function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pushWarning(warnings: AnalysisWarning[], warning: AnalysisWarning): void {
  if (warnings.some((item) => item.code === warning.code && item.message === warning.message)) return;
  warnings.push(warning);
}

/**
 * 正片时长以接口返回值为准；接口缺失或为 0 时用字幕结尾与最后一条弹幕兜底。
 * 时长是分块、裁剪和覆盖率守卫的共同口径，不能随便落回 0。
 */
function resolveDuration(
  duration: number,
  cues: SubtitleCue[],
  danmaku: DanmakuItem[]
): number {
  if (Number.isFinite(duration) && duration > 0) return duration;
  const cueEnd = cues.reduce(
    (max, cue) => (Number.isFinite(cue.end) ? Math.max(max, cue.end) : max),
    0
  );
  const danmakuEnd = danmaku.reduce(
    (max, item) => (Number.isFinite(item.time) ? Math.max(max, item.time) : max),
    0
  );
  return Math.max(cueEnd, danmakuEnd);
}

/** 播放器接口最多读几次：轨道缺失、串数据、覆盖不足都算没拿到，值得再试一次。 */
const PLAYER_ATTEMPTS = 3;
const PLAYER_RETRY_BASE_MS = 400;

interface SubtitleEvidence {
  player: PlayerInfo;
  cues: SubtitleCue[];
  /** 是否存在「通过校验」的字幕轨；false 时仅弹幕结果可以复用缓存。 */
  hasSubtitleTrack: boolean;
  /** 有轨道但正文为空：同样没有可复用的全量证据，仅弹幕缓存可以命中。 */
  subtitleBodyEmpty: boolean;
  warnings: AnalysisWarning[];
}

/** 一次字幕读取尝试的结果：拿没拿到台词、算不算串数据、原因是什么。 */
interface SubtitleAttempt {
  player: PlayerInfo;
  /** no_track：没有轨道；foreign：有轨道但都不是本视频；empty：轨道没正文；
   *  too_long：字幕比视频长；ok：拿到台词；fetch_failed：字幕请求失败。 */
  kind: "no_track" | "foreign" | "empty" | "too_long" | "ok" | "fetch_failed";
  cues: SubtitleCue[];
  reason?: string;
}

/** 一轮尝试：读播放器信息、挑轨道、取字幕并做串轨校验；重试节奏由调用方决定。 */
async function attemptSubtitle(deps: EvidenceDeps, video: VideoInfo): Promise<SubtitleAttempt> {
  const player = await deps.client.getPlayer(video.aid, video.cid, deps.signal);
  const track = pickSubtitleTrack(player.subtitles, video.aid, video.cid);
  if (!track) {
    // URL 为空的轨道就是没有字幕；有轨道但都不是本视频才算串数据。
    const foreign = player.subtitles.some((item) => item.url.trim().length > 0);
    return { player, kind: foreign ? "foreign" : "no_track", cues: [] };
  }
  try {
    const loaded = await deps.client.getSubtitle(track, deps.signal);
    if (loaded.length === 0) {
      return { player, kind: "empty", cues: [] };
    }
    // 字幕比视频还长，只可能是别的（更长）视频的字幕，这种数据不能要。
    if (subtitleOutrunsVideo(loaded, video.duration)) {
      return {
        player,
        kind: "too_long",
        cues: [],
        reason: `字幕比视频还长（${Math.round(lastCueEnd(loaded))} 秒 > ${Math.round(video.duration)} 秒）`
      };
    }
    return { player, kind: "ok", cues: loaded };
  } catch (error) {
    return { player, kind: "fetch_failed", cues: [], reason: `字幕读取失败：${errorText(error)}` };
  }
}

/**
 * 读播放器信息与字幕。播放器接口在稍后再看和高并发上下文里会把别的视频的
 * 字幕轨一起返回，拿错字幕会让 LLM 在错误的时间轴上判定，最后静默得出「无广告」。
 * 这里只挡两件事：文件名前缀是别的视频的 aid+cid，以及字幕比视频还长。
 * 字幕比视频短不算问题——片尾可能没有台词——有多少用多少，提示词里会写清
 * 字幕到哪一秒结束，让模型知道后面没有台词证据。
 */
async function loadSubtitleEvidence(
  deps: EvidenceDeps,
  video: VideoInfo,
  sleep: (ms: number) => Promise<void>
): Promise<SubtitleEvidence> {
  const warnings: AnalysisWarning[] = [];
  let player: PlayerInfo = EMPTY_PLAYER;
  let cues: SubtitleCue[] = [];
  let hasSubtitleTrack = false;
  let subtitleBodyEmpty = false;
  let accepted = false;
  let rejected = false;
  /** 降级原因，写进警告里，省得下次只能看到「未通过校验」。 */
  let rejectReason = "";

  for (let attempt = 0; attempt < PLAYER_ATTEMPTS; attempt += 1) {
    const result = await attemptSubtitle(deps, video);
    player = result.player;
    if (result.kind !== "no_track") hasSubtitleTrack = true;
    if (result.kind === "ok") {
      cues = result.cues;
      accepted = true;
      break;
    }
    if (result.kind === "empty") {
      subtitleBodyEmpty = true;
      pushWarning(warnings, { code: "subtitle_unavailable", message: "字幕轨没有正文" });
      accepted = true;
      break;
    }
    if (result.kind === "fetch_failed") {
      pushWarning(warnings, { code: "subtitle_fetch_failed", message: result.reason ?? "字幕读取失败" });
      break;
    }
    if (result.kind === "no_track" && !player.isLogin) {
      // 未登录时 AI 字幕本来就拿不到：再问两遍只会多两次请求、多等 1.2 秒，
      // 结论不会变。已登录时保留重试，接口偶发返回空列表是已知的不稳定行为。
      break;
    }
    if (result.kind === "foreign") {
      rejected = true;
      if (!rejectReason) rejectReason = "字幕文件名属于别的视频";
    }
    if (result.kind === "too_long") {
      rejected = true;
      if (!rejectReason) rejectReason = result.reason ?? "";
    }
    if (attempt + 1 < PLAYER_ATTEMPTS) {
      await sleep(PLAYER_RETRY_BASE_MS * (attempt + 1));
      continue;
    }
    break;
  }

  if (rejected && !accepted) {
    // 校验没过就退到弹幕：宁可少用证据，也不拿别的视频的字幕做判定。
    logWarn("字幕未通过校验，降级为弹幕分析", video.bvid, video.cid, rejectReason);
    pushWarning(warnings, {
      code: "subtitle_incomplete",
      message: `字幕轨未通过校验（${rejectReason || "不属于本视频或覆盖不足"}），已改用弹幕分析`
    });
    hasSubtitleTrack = false;
  } else if (!hasSubtitleTrack) {
    pushWarning(warnings, {
      code: "subtitle_missing",
      message: player.isLogin ? "该视频没有可用字幕" : "未登录或该视频没有可用字幕"
    });
  }
  if (!player.isLogin) {
    pushWarning(warnings, { code: "not_logged_in", message: "未登录 B 站，只能使用弹幕分析" });
  }
  return { player, cues, hasSubtitleTrack, subtitleBodyEmpty, warnings };
}

/** 播放器信息只影响字幕与登录态，读不到就降级为「仅弹幕」，不能中断分析。 */
async function loadEvidence(
  deps: EvidenceDeps,
  video: VideoInfo,
  sleep: (ms: number) => Promise<void>
): Promise<LoadedEvidence> {
  let loaded: SubtitleEvidence;
  try {
    loaded = await loadSubtitleEvidence(deps, video, sleep);
  } catch (error) {
    loaded = {
      player: EMPTY_PLAYER,
      cues: [],
      hasSubtitleTrack: false,
      subtitleBodyEmpty: false,
      warnings: [{ code: "partial", message: `播放器信息读取失败：${errorText(error)}` }]
    };
  }
  const mergedVideo: VideoInfo = {
    ...video,
    isLogin: loaded.player.isLogin,
    chapters: loaded.player.chapters.length > 0 ? loaded.player.chapters : video.chapters
  };
  // 时长在弹幕加载后由 completeEvidence 统一兜底；这里不提前算一遍。
  return {
    video: mergedVideo,
    mode: loaded.cues.length > 0 ? "full" : "danmaku",
    cues: loaded.cues,
    warnings: loaded.warnings,
    hasSubtitleTrack: loaded.hasSubtitleTrack,
    subtitleBodyEmpty: loaded.subtitleBodyEmpty
  };
}

interface DanmakuLoad {
  danmaku: DanmakuData;
  warnings: AnalysisWarning[];
}

/** 读弹幕；失败按「没有弹幕」降级，绝不抛错（弹幕与字幕互相独立）。 */
async function loadDanmakuData(
  client: BiliClient,
  cid: number,
  signal?: AbortSignal
): Promise<DanmakuLoad> {
  const warnings: AnalysisWarning[] = [];
  try {
    const danmaku = await client.getDanmaku(cid, signal);
    if (danmaku.items.length === 0) {
      pushWarning(warnings, { code: "danmaku_missing", message: "该视频没有弹幕" });
    }
    return { danmaku, warnings };
  } catch (error) {
    pushWarning(warnings, {
      code: "danmaku_missing",
      message: `弹幕读取失败：${errorText(error)}`
    });
    return { danmaku: { items: [] }, warnings };
  }
}

async function completeEvidence(
  deps: EvidenceDeps,
  evidence: LoadedEvidence,
  /** 已经发出的弹幕请求：与播放器/字幕并行拉，省一个往返。 */
  pendingDanmaku?: Promise<DanmakuLoad>
): Promise<CollectedData> {
  const danmaku =
    (await pendingDanmaku) ?? (await loadDanmakuData(deps.client, evidence.video.cid, deps.signal));
  evidence.warnings.push(...danmaku.warnings);
  // 字幕和弹幕都没读到：没有可读上下文，界面要说「无字幕也无弹幕」，
  // 不能显示成「仅弹幕」，也不能让角标显示「AD 0」。
  if (evidence.cues.length === 0 && danmaku.danmaku.items.length === 0) {
    pushWarning(evidence.warnings, {
      code: "no_context",
      message: "没有读到字幕，也没有读到弹幕"
    });
  }
  // 弹幕加载后再补一次时长兜底：仅弹幕模式没有字幕可用。
  evidence.video.duration = resolveDuration(
    evidence.video.duration,
    evidence.cues,
    danmaku.danmaku.items
  );
  const signals = buildSignals({
    title: evidence.video.title,
    description: evidence.video.description,
    duration: evidence.video.duration,
    cues: evidence.cues,
    danmaku: danmaku.danmaku.items,
    chapters: evidence.video.chapters
  });
  return { ...evidence, danmaku: danmaku.danmaku, signals };
}

/**
 * 一次分析要用的全部站点证据：视频信息、字幕、弹幕、信号。
 *
 * 连续对话分析器与决策分析器在同一刻各跑一遍，要取的是同一份数据。
 * 这里按视频建一个共享包：先到的发起请求，后到的等同一个 Promise；
 * 弹幕只依赖 cid，和播放器/字幕并行发出；信号集合也只算一次。
 * 包里保存的是原始证据（可能几 MB），所以共享表只留最近两个视频并带 TTL。
 */
interface EvidenceBundle {
  /** 视频信息（含 cid 与时长）。 */
  readonly video: Promise<VideoInfo>;
  /**
   * 播放器信息与字幕；调用时把弹幕请求一起发出去。
   *
   * 代价：若随后命中「仅弹幕」缓存而提前返回，这一条弹幕请求就白发了。
   * 那条路要求同一视频 5 分钟内重算且此刻读不到字幕，比常见路径少得多，
   * 用一次可能的浪费换每次分析少等一个往返。
   */
  subtitle(): Promise<LoadedEvidence>;
  /** 字幕 + 弹幕 + 信号；两个分析器拿到的是同一个只读对象。 */
  collect(): Promise<CollectedData>;
}

interface EvidenceBundleDeps extends EvidenceDeps {
  sleep: (ms: number) => Promise<void>;
}

export function openEvidence(
  input: { bvid: string; page: number },
  deps: EvidenceBundleDeps
): EvidenceBundle {
  const video = deps.client.getVideo(input.bvid, input.page, deps.signal);
  let danmaku: Promise<DanmakuLoad> | null = null;
  let subtitle: Promise<LoadedEvidence> | null = null;
  let collected: Promise<CollectedData> | null = null;

  const danmakuOnce = (): Promise<DanmakuLoad> => {
    danmaku ??= video.then((info) => loadDanmakuData(deps.client, info.cid, deps.signal));
    return danmaku;
  };

  const subtitleOnce = (): Promise<LoadedEvidence> => {
    subtitle ??= (async () => {
      // 先发弹幕：它只依赖 cid，与播放器/字幕没有先后关系。
      // 视频信息失败时这里会跟着失败，挂一个空 catch 免得产生未处理的拒绝。
      void danmakuOnce().catch(() => undefined);
      const info = await video;
      return loadEvidence(deps, info, deps.sleep);
    })();
    return subtitle;
  };

  const collectOnce = (): Promise<CollectedData> => {
    collected ??= (async () => {
      const loaded = await subtitleOnce();
      return completeEvidence(deps, loaded, danmakuOnce());
    })();
  // 失败不留在包上：下一次分析要能重新取数。
    void collected.catch(() => {
      collected = null;
    });
    return collected;
  };

  return { video, subtitle: subtitleOnce, collect: collectOnce };
}

/**
 * 共享表按取消信号归属：一次分析只有一个 AbortController，
 * 两条分析链拿到的是同一个 signal，于是共用同一个证据包。
 * 第二轮分析会换新的 signal，自然重新取数。
 * 用 WeakMap 而不是按视频号缓存：分析结束后不占内存，也不会把上一轮
 * 已经中止或已经过期的证据交给下一轮。
 */
const sharedBySignal = new WeakMap<AbortSignal, { key: string; bundle: EvidenceBundle }>();

function sharedKey(input: { bvid: string; page: number }): string {
  return `${input.bvid}:${input.page}`;
}

/**
 * 取本次分析共享的证据包。
 *
 * 没有取消信号时不共享：调用方本来就无法保证两次调用属于同一次分析，
 * 拿错证据比多发几个请求更糟。
 */
export function openSharedEvidence(
  input: { bvid: string; page: number },
  deps: EvidenceBundleDeps
): EvidenceBundle {
  const signal = deps.signal;
  if (!signal) return openEvidence(input, deps);
  const key = sharedKey(input);
  const hit = sharedBySignal.get(signal);
  if (hit && hit.key === key) return hit.bundle;
  const bundle = openEvidence(input, deps);
  sharedBySignal.set(signal, { key, bundle });
  return bundle;
}
