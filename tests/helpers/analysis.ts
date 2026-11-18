import { vi } from "vitest";
import { createStorageCache } from "../../src/core/ports/cache/store";
import { DEFAULT_POLICY } from "../../src/core/policy/policy";
import type { BiliClient } from "../../src/sites/bilibili/api/client";
import type { AnalysisPolicy } from "../../src/core/analysis/types";
import type { DanmakuData, PlayerInfo, SubtitleTrack, VideoInfo } from "../../src/sites/bilibili/types";
import type { SubtitleCue } from "../../src/core/plugin/types";
import type { LlmClient } from "../../src/core/ports/llm/client";
import type { AnalyzeDeps } from "../../src/sites/bilibili/analysis/analyzer";
import { createMemoryStorageArea } from "./memory-storage";

const AID = 1_234_567;
const CID = 42;

/**
 * 真实 AI 字幕的文件名是 <aid><cid><hash>，fixture 照这个形态组装，
 * 归属校验（字幕轨是否属于当前视频）才有东西可校。
 */
export const track: SubtitleTrack = {
  lan: "ai-zh",
  url: `https://aisubtitle.example/bfs/ai_subtitle/prod/${AID}${CID}6ec41b1bf1db994aa23f8d7c2d968b5a.json`
};

/** 可用字幕轨的「空 URL」形态：chooseSubtitleTrack 会认为没有轨道。 */
export const emptyTrack: SubtitleTrack = { ...track, url: "" };

/** 同形但文件名属于另一条视频的字幕轨：正常路径必须拒绝它。 */
export const foreignTrack: SubtitleTrack = {
  ...track,
  url: "https://aisubtitle.example/bfs/ai_subtitle/prod/113084375109318257497512148be901d2db8465225f5ed44.json"
};

/**
 * 覆盖到 598 / 600 秒的完整字幕；尾部那条用来过覆盖率校验。
 * 中间垫了四段 1400 字符的正片填充：按台词长度分块后，
 * 前 4 条加前 4 段填充 ≈ 5660 字符装进第一块，300 秒起的填充
 * 挤进第二块——600 秒视频恰好切成 [0,300] / [300,600] 两轮。
 */
export const FILLER = "正片".repeat(700);

export const cues: SubtitleCue[] = [
  { start: 90, end: 95, text: "接下来是广告时间" },
  { start: 95, end: 100, text: "本期视频由赞助商提供" },
  { start: 100, end: 110, text: "点击简介链接领取福利" },
  { start: 110, end: 120, text: "感谢赞助商" },
  { start: 130, end: 132, text: FILLER },
  { start: 170, end: 172, text: FILLER },
  { start: 210, end: 212, text: FILLER },
  { start: 250, end: 252, text: FILLER },
  { start: 300, end: 302, text: FILLER },
  { start: 588, end: 598, text: "今天就聊到这里" }
];

/** 300 秒视频的完整字幕（覆盖 298 / 300）：只切一个分块的用例用它。 */
export const cues300: SubtitleCue[] = [
  ...cues.slice(0, 4),
  { start: 290, end: 298, text: "收尾" }
];

export const danmaku: DanmakuData = {
  items: [
    { time: 100, mode: 1, text: "广告" },
    { time: 101, mode: 1, text: "恰饭" },
    { time: 102, mode: 1, text: "广告" },
    { time: 110, mode: 1, text: "空降 02:00" },
    { time: 111, mode: 1, text: "空降 02:00" },
    { time: 112, mode: 1, text: "空降 02:00" }
  ]
};

export function makeVideo(): VideoInfo {
  return {
    aid: AID,
    bvid: "BV1test",
    cid: CID,
    title: "测试视频",
    duration: 600,
    owner: "UP",
    description: "本期由赞助商提供",
    chapters: [{ start: 0, end: 60, title: "正片" }],
    isLogin: true
  };
}

export function makeClient(overrides: Partial<BiliClient> = {}): BiliClient {
  return {
    getVideo: vi.fn(async () => makeVideo()),
    getPlayer: vi.fn(async (): Promise<PlayerInfo> => ({
      isLogin: true,
      subtitles: [track],
      chapters: [{ start: 0, end: 60, title: "正片" }]
    })),
    getDanmaku: vi.fn(async () => danmaku),
    getSubtitle: vi.fn(async () => cues),
    ...overrides
  };
}

export function makeLlm(
  content = '{"segments":[{"start":100,"end":120,"kind":"sponsor","confidence":0.9,"evidence":["本期视频由赞助商提供"],"reason":"口播赞助"}]}'
): LlmClient {
  return {
    complete: vi.fn(async () => content),
  };
}

export interface DepsOverrides {
  client?: BiliClient;
  llm?: LlmClient;
  policy?: AnalysisPolicy;
  /** 服务商是否自动按前缀缓存；决定对话历史压缩还是全量保留。 */
  prefixCache?: boolean;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export function makeDeps(overrides: DepsOverrides = {}): AnalyzeDeps {
  return {
    client: overrides.client ?? makeClient(),
    llm: overrides.llm ?? makeLlm(),
    cache: createStorageCache(createMemoryStorageArea(), () => 1_000),
    policy: overrides.policy ?? DEFAULT_POLICY,
    promptVersion: "v1",
    model: "test-model",
    ...(overrides.prefixCache !== undefined ? { prefixCache: overrides.prefixCache } : {}),
    now: () => 1_000,
    sleep: overrides.sleep ?? (async () => {}),
    isCancelled: overrides.isCancelled,
    onProgress: overrides.onProgress
  };
}
