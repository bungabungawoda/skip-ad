// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_CLIENT_VERSION,
  TRANSCRIPT_PANEL_ID,
  panelIdCandidates,
  readClientVersion,
  requestPanelCues,
  type PanelFetch
} from "../panel-client";
import { buildPanelParams } from "../panel-cues";

const signal = new AbortController().signal;

/** 按真实响应复制结构：段在 macroMarkersPanelItemViewModel 里，深度约 15 层。 */
function panelBody(segments: Array<[string, string]>): string {
  return JSON.stringify({
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      macroMarkersPanelItemViewModel: {
                        item: {
                          timelineItemViewModel: {
                            contentItems: segments.map(([timestamp, simpleText]) => ({
                              transcriptSegmentViewModel: { timestamp, simpleText }
                            }))
                          }
                        }
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  });
}

function reply(body: string, status = 200) {
  return { ok: status < 400, status, text: async () => body };
}

function fetchMockReturning(body: string, status = 200): PanelFetch & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const fetchMock = vi.fn(async (url: string, init: unknown) => {
    calls.push([url, init]);
    return reply(body, status);
  });
  return Object.assign(fetchMock as unknown as PanelFetch, { calls });
}

function mountHtml(html: string, panelIds: string[] = []): void {
  document.body.innerHTML =
    `<script>var ytcfg = {INNERTUBE_CLIENT_VERSION: "${html}"};</script>` +
    panelIds
      .map((id) => `<ytd-engagement-panel-section-list-renderer target-id="${id}"></ytd-engagement-panel-section-list-renderer>`)
      .join("");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readClientVersion", () => {
  it("从页面内联脚本里读版本号", () => {
    mountHtml("2.20261111.01.00");
    expect(readClientVersion(document)).toBe("2.20261111.01.00");
  });

  it("读不到或格式不对时用兜底版本", () => {
    mountHtml("2.0");
    expect(readClientVersion(document)).toBe(FALLBACK_CLIENT_VERSION);
    document.body.innerHTML = "";
    expect(readClientVersion(document)).toBe(FALLBACK_CLIENT_VERSION);
  });
});

describe("panelIdCandidates", () => {
  it("常用的面板标识排第一，页面上的转写面板跟在后头", () => {
    mountHtml(FALLBACK_CLIENT_VERSION, [
      "PAyouchat",
      "engagement-panel-comments-section",
      "engagement-panel-searchable-transcript"
    ]);
    expect(panelIdCandidates(document)).toEqual([
      TRANSCRIPT_PANEL_ID,
      "engagement-panel-searchable-transcript"
    ]);
  });

  it("页面没有转写面板时只剩常用标识，且不重复", () => {
    mountHtml(FALLBACK_CLIENT_VERSION, [TRANSCRIPT_PANEL_ID]);
    expect(panelIdCandidates(document)).toEqual([TRANSCRIPT_PANEL_ID]);
  });
});

describe("requestPanelCues", () => {
  it("直发 get_panel：参数由 videoId 合成，返回解析好的 cues", async () => {
    const fetchMock = fetchMockReturning(panelBody([["0:00", "开头"], ["0:09", "中间"]]));
    document.body.innerHTML = "";

    const result = await requestPanelCues("EwtcDviZg68", {
      doc: document,
      fetch: fetchMock,
      durationSec: 600,
      signal
    });

    expect(result).toEqual({
      status: "ok",
      cues: [
        { start: 0, end: 9, text: "开头" },
        { start: 9, end: 11, text: "中间" }
      ]
    });
    const [url, init] = fetchMock.calls[0] ?? [];
    expect(url).toContain("/youtubei/v1/get_panel");
    const request = init as { method: string; credentials: string; headers: Record<string, string>; body: string };
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("include");
    expect(request.headers["X-Youtube-Client-Name"]).toBe("1");
    expect(request.headers["X-Youtube-Client-Version"]).toBe(FALLBACK_CLIENT_VERSION);
    const body = JSON.parse(request.body) as {
      panelId: string;
      params: string;
      context: { client: { clientName: string; clientVersion: string } };
    };
    expect(body.panelId).toBe(TRANSCRIPT_PANEL_ID);
    expect(body.params).toBe(buildPanelParams("EwtcDviZg68"));
    expect(body.context.client).toEqual({
      clientName: "WEB",
      clientVersion: FALLBACK_CLIENT_VERSION
    });
  });

  it("时长和字幕尾部对得上时，超过时长的段截掉", async () => {
    const fetchMock = fetchMockReturning(
      panelBody([["0:00", "开头"], ["0:09", "中间"], ["2:30", "超出"]])
    );
    const result = await requestPanelCues("abc", { doc: document, fetch: fetchMock, durationSec: 120, signal });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.cues).toEqual([
      { start: 0, end: 9, text: "开头" },
      { start: 9, end: 120, text: "中间" }
    ]);
  });

  it("时长比字幕尾部短一大截（广告时长、上一条视频）：不截断", async () => {
    const fetchMock = fetchMockReturning(
      panelBody([["0:00", "开头"], ["10:00", "中间"], ["1:00:00", "结尾"]])
    );
    const result = await requestPanelCues("abc", { doc: document, fetch: fetchMock, durationSec: 30, signal });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.cues.map((cue) => cue.text)).toEqual(["开头", "中间", "结尾"]);
  });

  it("主面板没有段时换下一个候选面板", async () => {
    mountHtml(FALLBACK_CLIENT_VERSION, ["engagement-panel-searchable-transcript"]);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { panelId: string };
      calls.push(body.panelId);
      return body.panelId === TRANSCRIPT_PANEL_ID
        ? reply(JSON.stringify({ content: {} }))
        : reply(panelBody([["0:01", "备用面板"]]));
    }) as unknown as PanelFetch;

    const result = await requestPanelCues("abc", { doc: document, fetch: fetchMock, signal });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.cues).toEqual([{ start: 1, end: 3, text: "备用面板" }]);
    expect(calls).toEqual([TRANSCRIPT_PANEL_ID, "engagement-panel-searchable-transcript"]);
  });

  it("status 403 / 空正文 / 坏 JSON / 无段 / 网络错误：各自给原因", async () => {
    const cases: Array<[PanelFetch, string]> = [
      [vi.fn(async () => reply("", 403)) as unknown as PanelFetch, "面板 status 403"],
      [vi.fn(async () => reply("")) as unknown as PanelFetch, "面板返回空正文"],
      [vi.fn(async () => reply("<html>Sorry...</html>")) as unknown as PanelFetch, "面板返回的不是 JSON"],
      [vi.fn(async () => reply(JSON.stringify({ content: {} }))) as unknown as PanelFetch, "面板里没有可用的字幕段"],
      [
        vi.fn(async () => {
          throw new Error("network down");
        }) as unknown as PanelFetch,
        "network down"
      ]
    ];
    document.body.innerHTML = "";
    for (const [fetchMock, detail] of cases) {
      const result = await requestPanelCues("abc", { doc: document, fetch: fetchMock, signal });
      expect(result).toEqual({ status: "failed", detail });
    }
  });

  it("信号已取消时把 AbortError 抛给调用方，不折成失败原因", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as PanelFetch;

    await expect(
      requestPanelCues("abc", { doc: document, fetch: fetchMock, signal: controller.signal })
    ).rejects.toThrow("Aborted");
  });

  it("面板请求一直不返回时超时，并进入下一个候选面板或返回失败原因", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      ) as unknown as PanelFetch;
      const pending = requestPanelCues("abc", {
        doc: document,
        fetch: hanging,
        signal,
        timeoutMs: 1_000
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({
        status: "failed",
        detail: "面板请求超时（1 秒）"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
