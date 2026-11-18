import type { SubtitleCue } from "../../core/plugin/types";
import { logWarn } from "../../core/lib/log";
import { readString } from "../../core/lib/record";
import { buildPanelParams, parsePanelCues } from "./panel-cues";

/**
 * 转写面板客户端（隔离世界直发）。
 *
 * 内容脚本的 fetch 与页面同源：不带扩展 origin、带页面 cookie，`get_panel`
 * 稳定 200。扩展 origin（service worker / offscreen）发同样的请求会被
 * Google 反滥用拦成 403 + "Sorry..." 页——之前记的「必须 MAIN 世界代发」
 * 实际测的是扩展 origin 的请求。
 *
 * 面板参数由 videoId 合成（见 panel-cues），所以这里不需要页面的播放器数据：
 * 拿不到网页数据（桥缺失、SPA 还没切换）也能读字幕。
 */

/** 转写面板的 panelId；YouTube 改版时按页面上的 target-id 兜底。 */
export const TRANSCRIPT_PANEL_ID = "PAmodern_transcript_view";

/**
 * 读不到页面版本号时用的客户端版本。实测任意真实格式的版本号都能用
 * （一年前的也可以），只有 `2.0` 这类假版本会 404。
 */
export const FALLBACK_CLIENT_VERSION = "2.20261111.01.00";

const CLIENT_VERSION_PATTERN = /^2\.\d{8}\.\d{2}\.\d{2}$/;

/** 页面只有这一处能读到客户端版本：内联脚本里 `ytcfg.set` 的字段。 */
export function readClientVersion(doc: Document = document): string {
  // 先看 head（约 0.9 MB），没有再看整份文档；整份序列化在真机上也只有几毫秒。
  const html = doc.head?.innerHTML || doc.documentElement?.innerHTML || "";
  const match = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
  const fromHtml = readString(match?.[1]).trim();
  return CLIENT_VERSION_PATTERN.test(fromHtml) ? fromHtml : FALLBACK_CLIENT_VERSION;
}

/**
 * 面板候选，按顺序试。常用的 `PAmodern_transcript_view` 放最前；
 * 页面里出现别的转写面板标识时一并带上，应付改版改名。
 */
export function panelIdCandidates(doc: Document = document): string[] {
  const candidates = [TRANSCRIPT_PANEL_ID];
  for (const element of doc.querySelectorAll("ytd-engagement-panel-section-list-renderer[target-id]")) {
    const id = readString(element.getAttribute("target-id")).trim();
    if (id && /transcript/i.test(id) && !candidates.includes(id)) candidates.push(id);
  }
  return candidates;
}

/** 只依赖 ok/status/text 的最小 fetch 形状，测试可以注入假实现。 */
interface PanelFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PanelFetch = (
  url: string,
  init: {
    method: "POST";
    credentials: "include";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<PanelFetchResponse>;

export type PanelClientResult =
  | { status: "ok"; cues: SubtitleCue[] }
  | { status: "failed"; detail: string };

export interface PanelClientDeps {
  doc?: Document;
  fetch?: PanelFetch;
  /** 截断用；读不到就带上 undefined，不猜。 */
  durationSec?: number;
  signal: AbortSignal;
  /** 单次面板请求上限；超时后换下一个候选面板。 */
  timeoutMs?: number;
}

const PANEL_URL = "https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false";
const PANEL_TIMEOUT_MS = 15_000;

/**
 * 面板段允许超出正片时长多少秒。面板会比视频长出一点（尾部重复、剪过的片子），
 * 但长出一大截说明手里的时长根本不是正片的（广告期间读到的是广告时长），
 * 这时候不能拿它裁字幕，否则会把整段正文丢掉。
 */
const DURATION_TRUST_MARGIN_SEC = 60;

/** 只有时长和字幕尾部对得上才截断。 */
function clampToDuration(cues: SubtitleCue[], durationSec: number | undefined): SubtitleCue[] {
  if (durationSec === undefined || durationSec <= 0 || cues.length === 0) return cues;
  const lastStart = cues[cues.length - 1]?.start ?? 0;
  if (lastStart > durationSec + DURATION_TRUST_MARGIN_SEC) return cues;
  return cues
    .filter((cue) => cue.start < durationSec)
    .map((cue) => ({ ...cue, end: Math.min(cue.end, durationSec) }));
}

type PanelAttempt = { kind: "ok"; cues: SubtitleCue[] } | { kind: "next"; detail: string };

async function callPanel(
  videoId: string,
  panelId: string,
  clientVersion: string,
  durationSec: number | undefined,
  signal: AbortSignal,
  fetchFn: PanelFetch,
  timeoutMs: number
): Promise<PanelAttempt> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onExternalAbort, { once: true });
  const timeoutDetail = `面板请求超时（${Math.round(timeoutMs / 1_000)} 秒）`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<PanelAttempt>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: "next", detail: timeoutDetail });
    }, timeoutMs);
  });
  // 取正文也算在 try 里：连接中途断开时退下一个候选面板，不把异常抛给分析层。
  const request = (async (): Promise<PanelAttempt> => {
    try {
      const response = await fetchFn(PANEL_URL, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "X-Youtube-Client-Name": "1",
          "X-Youtube-Client-Version": clientVersion
        },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion } },
          panelId,
          params: buildPanelParams(videoId)
        }),
        signal: controller.signal
      });
      if (!response.ok) return { kind: "next", detail: `面板 status ${response.status}` };
      const text = await response.text();
      // 空正文与坏 JSON 要分开：前者是「这个面板没内容」，后者是数据坏了。
      if (text.trim().length === 0) return { kind: "next", detail: "面板返回空正文" };
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return { kind: "next", detail: "面板返回的不是 JSON" };
      }
      const cues = clampToDuration(parsePanelCues(payload), durationSec);
      return cues.length > 0
        ? { kind: "ok", cues }
        : { kind: "next", detail: "面板里没有可用的字幕段" };
    } catch (error) {
      if (signal.aborted) throw error;
      if (timedOut) return { kind: "next", detail: timeoutDetail };
      return { kind: "next", detail: error instanceof Error ? error.message : String(error) };
    }
  })();
  // 超时先返回时，原请求之后才拒绝也不能留下未处理的 Promise。
  void request.catch(() => undefined);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 取当前视频的转写面板 cues：参数由 videoId 合成，候选 panelId 依次试，
 * 首个有段的就返回。全部失败时把最后一条原因交给调用方。
 */
export async function requestPanelCues(
  videoId: string,
  deps: PanelClientDeps
): Promise<PanelClientResult> {
  const doc = deps.doc ?? document;
  const fetchFn = deps.fetch ?? (fetch as PanelFetch);
  const clientVersion = readClientVersion(doc);
  const timeoutMs = deps.timeoutMs ?? PANEL_TIMEOUT_MS;
  let lastDetail = "";

  for (const panelId of panelIdCandidates(doc)) {
    const attempt = await callPanel(
      videoId,
      panelId,
      clientVersion,
      deps.durationSec,
      deps.signal,
      fetchFn,
      timeoutMs
    );
    if (attempt.kind === "ok") return { status: "ok", cues: attempt.cues };
    lastDetail = attempt.detail;
  }

  logWarn("转写面板没有可用字幕", videoId, lastDetail || "没有可用的面板标识");
  return { status: "failed", detail: lastDetail || "没有可用的面板标识" };
}
