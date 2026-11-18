// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscript,
  parseJson3Track,
  captionTracksFromResponse,
  type TranscriptDeps,
  type TranscriptFetch,
  type TranscriptFetchInit
} from "../transcript";
import { readPlayerResponse } from "../page-data";
import type { PlayerDataResult } from "../player-bridge";
import type { PanelClientResult, PanelClientDeps } from "../panel-client";
import type { BridgeTrack } from "../player-bridge-protocol";

function bridgeTrack(overrides: Partial<BridgeTrack> = {}): BridgeTrack {
  return {
    baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh",
    languageCode: "zh",
    name: "中文",
    ...overrides
  };
}

function okBridge(videoId: string, tracks: BridgeTrack[], lengthSeconds = 600): PlayerDataResult {
  return { status: "ok", videoId, source: "app", lengthSeconds, tracks };
}

type PanelClient = (videoId: string, deps: PanelClientDeps) => Promise<PanelClientResult>;

function panelOk(cues: Array<{ start: number; end: number; text: string }>): PanelClient & {
  mock: { calls: Array<[string, PanelClientDeps]> };
} {
  const fn = vi.fn(async () => ({ status: "ok" as const, cues }));
  return fn as unknown as PanelClient & { mock: { calls: Array<[string, PanelClientDeps]> } };
}

function panelFailed(detail = "面板里没有可用的字幕段"): PanelClient & {
  mock: { calls: Array<[string, PanelClientDeps]> };
} {
  const fn = vi.fn(async () => ({ status: "failed" as const, detail }));
  return fn as unknown as PanelClient & { mock: { calls: Array<[string, PanelClientDeps]> } };
}

/** 默认：面板没字幕。要测面板成功的用例自己传 requestPanelCues。 */
function load(deps: TranscriptDeps) {
  return loadTranscript("abc", signal, {
    doc: document,
    requestPanelCues: panelFailed(),
    ...deps
  });
}

function json3(cues: Array<[number, number, string]>) {
  return {
    events: cues.map(([start, duration, text]) => ({
      tStartMs: start * 1_000,
      dDurationMs: duration * 1_000,
      segs: [{ utf8: text }]
    }))
  };
}

function fetchReturning(payload: unknown) {
  return vi.fn(async (url: string, init: TranscriptFetchInit) => {
    void url;
    void init;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  });
}

function mountInline(response: unknown): void {
  delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  document.body.innerHTML = `<script>var ytInitialPlayerResponse = ${JSON.stringify(response)};</script>`;
}

/** 页面上的 <video> 时长；happy-dom 默认没有时长，这里补一个可控的。 */
function mountVideoDuration(seconds: number): void {
  const video = document.createElement("video");
  Object.defineProperty(video, "duration", { configurable: true, get: () => seconds });
  document.body.append(video);
}

function mountFlexyVideoId(videoId: string): void {
  const flexy = document.createElement("ytd-watch-flexy");
  flexy.setAttribute("video-id", videoId);
  document.body.append(flexy);
}

const signal = new AbortController().signal;

afterEach(() => {
  delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  document.body.innerHTML = "";
});

describe("parseJson3Track", () => {
  it("把 tStartMs 与 dDurationMs 换算成秒，缺时长时给 2 秒", () => {
    const cues = parseJson3Track({
      events: [
        { tStartMs: 5_000, dDurationMs: 2_000, segs: [{ utf8: "你好" }, { utf8: "世界" }] },
        { tStartMs: 10_000, segs: [{ utf8: "没有时长" }] },
        { tStartMs: "bad", segs: [{ utf8: "坏" }] },
        { tStartMs: 20_000, segs: [] }
      ]
    });
    expect(cues).toEqual([
      { start: 5, end: 7, text: "你好世界" },
      { start: 10, end: 12, text: "没有时长" }
    ]);
  });

  it("结构不合法时返回空数组", () => {
    expect(parseJson3Track(null)).toEqual([]);
    expect(parseJson3Track({ events: "nope" })).toEqual([]);
  });
});

describe("captionTracksFromResponse", () => {
  it("多轨道时先读人工轨，自动轨留作后备", async () => {
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes("lang=en")) {
        return { ok: false, status: 403, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(json3([[0, 1, "中文"]])) };
    });
    const zhHuman = bridgeTrack({ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh" });
    const enAuto = bridgeTrack({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en",
      kind: "asr"
    });
    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, [enAuto, zhHuman]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "player" });
    expect(fetched[0]).toContain("lang=zh");
    expect(fetched.some((url) => url.includes("lang=en"))).toBe(false);
  });

  it("从内联脚本读取轨道，缺 baseUrl 或 languageCode 的跳过", () => {
    delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    document.body.innerHTML = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://x","languageCode":"zh","name":{"simpleText":"中文"}},{"baseUrl":"","languageCode":"en"}]}}};</script>`;
    const tracks = captionTracksFromResponse(readPlayerResponse(document));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ lang: "zh", label: "中文", isAuto: false });
  });
});

describe("timedtext 兜底超时", () => {
  it("请求一直不返回时按本条轨道失败，不会挂到用户切视频", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = vi.fn(
        (_url: string, init: TranscriptFetchInit) =>
          new Promise<never>((_, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      );
      const pending = load({
        requestPlayerData: vi.fn(async () => okBridge("abc", [bridgeTrack()])),
        fetch: hangingFetch as unknown as TranscriptFetch
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.kind).toBe("transcript_fetch_failed");
      expect(result.kind === "transcript_fetch_failed" ? result.detail : "").toContain("超时");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadTranscript — 转写面板优先", () => {
  it("面板有字幕：直接用面板结果，不问播放器桥", async () => {
    mountVideoDuration(600);
    mountFlexyVideoId("abc");
    const bridge = vi.fn(async (): Promise<PlayerDataResult> => okBridge("abc", [bridgeTrack()]));
    const panel = panelOk([
      { start: 0, end: 8, text: "开头" },
      { start: 8, end: 10, text: "第二段" }
    ]);
    const fetchMock = fetchReturning(json3([]));

    const result = await load({
      requestPlayerData: bridge,
      requestPanelCues: panel,
      fetch: fetchMock
    });

    expect(result).toEqual({
      kind: "transcript",
      source: "panel",
      durationSec: 600,
      cues: [
        { start: 0, end: 8, text: "开头" },
        { start: 8, end: 10, text: "第二段" }
      ]
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // 面板请求带上页面里核对过的时长
    expect(panel.mock.calls[0]?.[1]).toMatchObject({ durationSec: 600 });
  });

  it("广告期间面板有字幕：不把广告时长当成正片时长", async () => {
    mountVideoDuration(30);
    mountFlexyVideoId("abc");
    const adPlayer = document.createElement("div");
    adPlayer.id = "movie_player";
    adPlayer.classList.add("ad-showing");
    document.body.append(adPlayer);
    const result = await load({
      requestPanelCues: panelOk([{ start: 0, end: 8, text: "开头" }])
    });

    expect(result).toEqual({
      kind: "transcript",
      source: "panel",
      cues: [{ start: 0, end: 8, text: "开头" }]
    });
  });

  it("页面的 video-id 还没切到当前视频：不拿旧时长裁字幕", async () => {
    mountVideoDuration(600);
    mountFlexyVideoId("stale");
    const result = await load({
      requestPanelCues: panelOk([{ start: 0, end: 8, text: "开头" }])
    });

    expect(result).toEqual({
      kind: "transcript",
      source: "panel",
      cues: [{ start: 0, end: 8, text: "开头" }]
    });
  });

  it("面板返回 ok 但没段：问桥，桥说当前视频没有轨道才判定没有字幕", async () => {
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPanelCues: panelOk([]),
      requestPlayerData: async (videoId) => okBridge(videoId, []),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result).toEqual({ kind: "no_transcript", source: "player", durationSec: 600 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("面板失败：桥有轨道时退 timedtext，两边原因都留在 detail", async () => {
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPanelCues: panelFailed("面板 status 403"),
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("transcript_fetch_failed");
    if (result.kind !== "transcript_fetch_failed") throw new Error("expected failure");
    expect(result.detail).toContain("字幕轨没有正文");
    expect(result.detail).toContain("面板 status 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("面板失败但 timedtext 能拿到正文：仍然用轨道字幕", async () => {
    const result = await load({
      requestPanelCues: panelFailed(),
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
      fetch: fetchReturning(json3([[1, 2, "轨道字幕"]])),
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "player", durationSec: 600 });
  });

  it("桥没给时长时，不用页面 video 的时长", async () => {
    mountVideoDuration(30);
    const result = await load({
      requestPanelCues: panelFailed(),
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()], 0),
      fetch: fetchReturning(json3([[1, 2, "轨道字幕"]])),
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "player" });
    expect(result).not.toHaveProperty("durationSec");
  });

  it("面板请求被取消：AbortError 向上抛，不折成失败原因", async () => {
    const controller = new AbortController();
    controller.abort();
    const panel: PanelClient = async () => {
      throw new DOMException("Aborted", "AbortError");
    };

    await expect(
      loadTranscript("abc", controller.signal, { doc: document, requestPanelCues: panel })
    ).rejects.toThrow("Aborted");
  });
});

describe("loadTranscript — 面板拿不到时用播放器数据解释", () => {
  it("桥明确返回空轨道：才判定当前视频没有字幕", async () => {
    document.body.innerHTML = "";
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, []),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result).toEqual({ kind: "no_transcript", source: "player", durationSec: 600 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("播放器还没切到当前视频：短等后重试，切过来后使用新视频", async () => {
    let calls = 0;
    const result = await load({
      requestPlayerData: async (videoId) => {
        calls += 1;
        if (calls === 1) return { status: "not-ready", videoId: "stale" };
        return okBridge(videoId, [bridgeTrack()]);
      },
      fetch: fetchReturning(json3([[0, 1, "新视频"]])),
      sleep: async () => {},
      bridgeDeadlineMs: 1_000
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ kind: "transcript", source: "player" });
  });

  it("桥不可用且内联快照属于上一支视频：返回没读到，不返回没有字幕", async () => {
    mountInline({
      videoDetails: { videoId: "stale", lengthSeconds: 999 },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=stale&lang=zh", languageCode: "zh" }
          ]
        }
      }
    });
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPlayerData: async () => ({ status: "unavailable", detail: "桥没有响应" }),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("player_data_unavailable");
    expect(result.kind).not.toBe("no_transcript");
    if (result.kind !== "player_data_unavailable") throw new Error("expected unavailable");
    expect(result.detail).toContain("桥没有响应");
    expect(result.detail).toContain("面板里没有可用的字幕段");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("桥不可用且内联快照属于当前视频：可以用它的轨道", async () => {
    mountInline({
      videoDetails: { videoId: "abc", lengthSeconds: 600 },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh",
              languageCode: "zh",
              name: { simpleText: "中文" }
            }
          ]
        }
      }
    });
    const fetchMock = fetchReturning(json3([[0, 1, "内联字幕"]]));
    const result = await load({
      requestPlayerData: async () => ({ status: "unavailable", detail: "桥没有响应" }),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "inline", durationSec: 600 });
  });

  it("桥不可用且内联快照没有时长时，不用页面 video 的时长", async () => {
    mountVideoDuration(30);
    mountInline({
      videoDetails: { videoId: "abc" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh",
              languageCode: "zh",
              name: { simpleText: "中文" }
            }
          ]
        }
      }
    });
    const result = await load({
      requestPlayerData: async () => ({ status: "unavailable", detail: "桥没有响应" }),
      fetch: fetchReturning(json3([[0, 1, "内联字幕"]])),
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "inline" });
    expect(result).not.toHaveProperty("durationSec");
  });

  it("桥不可用且内联快照属于当前视频但没有轨道：仍然返回没读到", async () => {
    mountInline({ videoDetails: { videoId: "abc", lengthSeconds: 600 } });
    const result = await load({
      requestPlayerData: async () => ({ status: "unavailable", detail: "桥没有响应" }),
      fetch: fetchReturning(json3([])),
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("player_data_unavailable");
    expect(result.kind).not.toBe("no_transcript");
  });

  it("桥不可用且页面里还开着别的视频的 transcript DOM：不使用 DOM 字幕", async () => {
    // 真实事故：SPA 导航后面板 DOM 里还是上一条视频的字幕，被当成当前视频
    // 缓存了。宁可读不到，也不能读错，所以 DOM 兜底已删。
    document.body.innerHTML = `
      <ytd-transcript-segment-renderer>
        <div class="segment-timestamp">1:23</div><div class="segment-text">上一条视频的字幕</div>
      </ytd-transcript-segment-renderer>
    `;
    const result = await load({
      requestPlayerData: async () => ({ status: "unavailable", detail: "桥没有响应" }),
      fetch: fetchReturning(json3([])),
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("player_data_unavailable");
  });
});

describe("loadTranscript — timedtext 轨道的失败口径", () => {
  it("轨道正文拉取失败：报告读取失败，不是没有字幕", async () => {
    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
      fetch: vi.fn(async () => ({ ok: false, status: 403, text: async () => "" })),
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript_fetch_failed" });
    if (result.kind !== "transcript_fetch_failed") throw new Error("expected failure");
    expect(result.detail).toContain("status 403");
  });

  it("baseUrl 不是 YouTube 域名时不发请求", async () => {
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPlayerData: async (videoId) =>
        okBridge(videoId, [bridgeTrack({ baseUrl: "https://evil.example/api/timedtext?v=abc" })]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("transcript_fetch_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("baseUrl 的 v 参数与当前视频不一致时不发请求", async () => {
    const fetchMock = fetchReturning(json3([]));
    const result = await load({
      requestPlayerData: async (videoId) =>
        okBridge(videoId, [
          bridgeTrack({ baseUrl: "https://www.youtube.com/api/timedtext?v=stale&lang=zh" })
        ]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("transcript_fetch_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("第一条轨道 403：换下一条轨道，去重不重复请求", async () => {
    const zh = bridgeTrack({ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh" });
    const en = bridgeTrack({ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en" });
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("lang=zh")) return { ok: false, status: 403, text: async () => "" };
      return { ok: true, status: 200, text: async () => JSON.stringify(json3([[0, 1, "英文"]])) };
    });

    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, [zh, en]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result).toMatchObject({ kind: "transcript", source: "player" });
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => !u.includes("lang=zh") || u === urls[0])).toBe(true);
  });

  it("timedtext 200 空正文：detail 写「字幕轨返回空正文」", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    expect(result.kind).toBe("transcript_fetch_failed");
    if (result.kind !== "transcript_fetch_failed") throw new Error("expected failure");
    expect(result.detail).toContain("字幕轨返回空正文");
  });

  it("timedtext 返回的不是 JSON：detail 写「字幕轨返回的不是 JSON」", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html>no</html>" }));
    const result = await load({
      requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    if (result.kind !== "transcript_fetch_failed") throw new Error("expected failure");
    expect(result.detail).toContain("字幕轨返回的不是 JSON");
  });

  it("已有 fmt 与 xosf 时用参数覆盖，不盲拼", async () => {
    const fetchMock = fetchReturning(json3([[0, 1, "格式"]]));
    await load({
      requestPlayerData: async (videoId) =>
        okBridge(videoId, [
          bridgeTrack({
            baseUrl: "https://www.youtube.com/api/timedtext?v=abc&fmt=srv3&xosf=1&lang=zh"
          })
        ]),
      fetch: fetchMock,
      bridgeDeadlineMs: 0
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("fmt")).toBe("json3");
    expect(url.searchParams.has("xosf")).toBe(false);
  });

  it("fetch 中途信号被中止：向上抛 AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      loadTranscript("abc", controller.signal, {
        doc: document,
        requestPanelCues: panelFailed(),
        requestPlayerData: async (videoId) => okBridge(videoId, [bridgeTrack()]),
        fetch: fetchMock,
        bridgeDeadlineMs: 0
      })
    ).rejects.toThrow("Aborted");
  });
});
