import type {
  AnalysisServices,
  OverlayAdapter,
  PlayerAdapter,
  SiteAdapter,
  VideoKey
} from "../../core/plugin/types";
import type { VideoLocation } from "./types";
import { createBilibiliSegmentAnalyzer } from "./analysis/analyzer";
import { createBilibiliDecisionAnalyzer } from "./analysis/decision-analyzer";

/**
 * 哔哩哔哩适配器：URL 解析、播放器查找与浮层挂载点都留在本目录。
 * /video/ 与 /list/ 页、多 P、查询参数解析（原 src/bili/location.ts）并入这里。
 */

const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]+)\/?/;
// 稍后再看、收藏夹这类列表播放页：/list/<列表类型>?bvid=BV...，bvid 在查询参数里
const LIST_PATH = /^\/list\/[^/]+\/?$/;
const BV_ID = /^BV[0-9A-Za-z]+$/;

export function parseVideoLocation(href: string): VideoLocation | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== "www.bilibili.com") return null;
  const videoMatch = url.pathname.match(VIDEO_PATH);
  const bvid =
    videoMatch?.[1] ??
    (LIST_PATH.test(url.pathname) ? url.searchParams.get("bvid") : null);
  if (!bvid || !BV_ID.test(bvid)) return null;
  const rawPage = Number(url.searchParams.get("p") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return { bvid, page };
}

function createPlayerAdapter(): PlayerAdapter {
  return {
    findVideo() {
      // 列表页还可能有预览播放器：优先取播放器容器里的 video，找不到再退回全页第一个。
      return (
        document.querySelector<HTMLVideoElement>(".bpx-player-container video") ??
        document.querySelector<HTMLVideoElement>("video")
      );
    }
  };
}

const overlay: OverlayAdapter = {
  // 播放器容器：Toast 浮层挂载为其子元素。
  anchor: ".bpx-player-container",
  // 原生进度条轨道。没有章节时 wrap 下只有一个不带 -segment 的 schedule；
  // 有章节时 B 站把每个章节渲染成 .bpx-player-progress-schedule-segment，
  // 只排除它们会一个节点都匹配不到，所以直接取和进度条同宽同高的 wrap。
  progressAnchor: ".bpx-player-progress-schedule-wrap",
  // 胶囊挂在进度条本体上：wrap 会被站点按章节裁切，进度条本体不裁剪。
  snapAnchor: ".bpx-player-progress"
};

export function createBilibiliAdapter(): SiteAdapter {
  return {
    resolveVideo(url: URL): VideoKey | null {
      const location = parseVideoLocation(url.href);
      if (!location) return null;
      // 会话标识取 URL 可解析的形态：partId 先用分 P 序号；
      // 分析器拿到 cid 后在结果里给出最终 VideoKey（partId = cid）。
      return {
        site: "bilibili",
        videoId: location.bvid,
        partId: String(location.page)
      };
    },
    player: createPlayerAdapter(),
    createSegmentAnalyzer(services: AnalysisServices) {
      return createBilibiliSegmentAnalyzer(services);
    },
    createDecisionAnalyzer(services: AnalysisServices) {
      return createBilibiliDecisionAnalyzer(services);
    },
    overlay,
    pageTitle() {
      return (document.title ?? "")
        .replace(/_哔哩哔哩_bilibili\s*$/, "")
        .replace(/-哔哩哔哩\s*$/, "")
        .trim();
    }
  };
}
