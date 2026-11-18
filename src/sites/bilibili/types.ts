import type { AnalysisMode } from "../../core/analysis/types";
import type { Chapter } from "../../core/plugin/types";

/**
 * 哔哩哔哩站内类型：只在本目录及其 __tests__ 中使用，不进 core。
 * 视频标识统一用 core 的 VideoKey（videoId = bvid，partId = cid）。
 * 证据形态复用 core 的联合：有字幕全文是 full，退化为弹幕是 danmaku。
 */
export type { AnalysisMode };
/** 字幕行是 core 的数据契约，站内代码统一从这里引用。 */
export type { SubtitleCue } from "../../core/plugin/types";

export interface DanmakuItem {
  time: number;
  mode: number;
  text: string;
  /** 证据层去重后的出现次数；原始弹幕没有这个字段。 */
  count?: number;
}

export interface DanmakuData {
  items: DanmakuItem[];
}

export interface VideoPage {
  cid: number;
  page: number;
  /** 该分 P 自身的时长；多 P 视频里 data.duration 是全部 P 之和，不能直接用。 */
  duration?: number;
}

export interface VideoInfo {
  /** 稿件数字 ID（av 号）。播放器字幕接口 wbi/v2 只认 aid + cid。 */
  aid: number;
  bvid: string;
  cid: number;
  title: string;
  duration: number;
  owner: string;
  description: string;
  chapters: Chapter[];
  isLogin: boolean;
}

export interface SubtitleTrack {
  lan: string;
  url: string;
}

export interface PlayerInfo {
  isLogin: boolean;
  subtitles: SubtitleTrack[];
  chapters: Chapter[];
}

export interface VideoLocation {
  bvid: string;
  page: number;
}
