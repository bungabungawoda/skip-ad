import { describe, expect, it, vi } from "vitest";
import { BiliApiError, createBiliClient } from "../api/client";
import type { FetchLike } from "../../../core/lib/http";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function route(handler: (url: string) => Response): FetchLike {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
}

const viewPayload = {
  code: 0,
  data: {
    aid: 9001,
    bvid: "BV1test",
    cid: 42,
    title: "视频标题",
    duration: 600,
    owner: { name: "UP" },
    desc: "简介",
    pages: [
      { cid: 42, page: 1, part: "P1" },
      { cid: 43, page: 2, part: "P2" }
    ]
  }
};

describe("Bilibili client", () => {
  it("reads video info and selects the requested page", async () => {
    const client = createBiliClient(route(() => json(viewPayload)));
    const video = await client.getVideo("BV1test", 2);
    expect(video.cid).toBe(43);
    expect(video.aid).toBe(9001);
    expect(video.title).toBe("视频标题");
  });

  it("throws when the payload has no page list but a page other than 1 is requested", async () => {
    // 没有分 P 列表时 data.cid 只能证明是第 1 个分 P；其他分 P 必须报错，
    // 不能静默回退到第 1 个分 P 的时间轴。
    const withoutPages = {
      code: 0,
      data: { cid: 42, title: "视频", duration: 10, desc: "" }
    };
    const client = createBiliClient(route(() => json(withoutPages)));
    await expect(client.getVideo("BV1test", 5)).rejects.toBeInstanceOf(BiliApiError);
  });

  it("still reads a single-page video when the page list is missing", async () => {
    const withoutPages = {
      code: 0,
      data: { cid: 42, title: "视频", duration: 10, desc: "" }
    };
    const client = createBiliClient(route(() => json(withoutPages)));
    const video = await client.getVideo("BV1test", 1);
    expect(video.cid).toBe(42);
    expect(video.duration).toBe(10);
  });

  it("throws on API codes and HTTP errors", async () => {
    const codeClient = createBiliClient(route(() => json({ code: -400, data: {} })));
    await expect(codeClient.getVideo("BV1test", 1)).rejects.toBeInstanceOf(BiliApiError);
    const httpClient = createBiliClient(route(() => new Response("no", { status: 500 })));
    await expect(httpClient.getVideo("BV1test", 1)).rejects.toThrow(/status 500/);
  });

  it("reads player tracks, chapters, and login state from the wbi endpoint", async () => {
    const urls: string[] = [];
    const client = createBiliClient(
      route((url) => {
        urls.push(url);
        return json({
          code: 0,
          data: {
            login_mid: 123,
            subtitle: {
              subtitles: [
                { lan: "ai-zh", lan_doc: "中文", subtitle_url: "//example.com/zh.json" },
                { lan: "ai-en", lan_doc: "English", subtitle_url: "" }
              ]
            },
            view_points: [
              { from: 0, to: 60, content: "正片" },
              { from: 60, to: 50, content: "倒置" }
            ]
          }
        });
      })
    );
    const player = await client.getPlayer(9001, 42);
    // 播放器自己也走 wbi/v2，且只认 aid + cid；/x/player/v2?bvid= 会串成别的视频的字幕。
    expect(urls[0]).toBe("https://api.bilibili.com/x/player/wbi/v2?aid=9001&cid=42");
    expect(player.isLogin).toBe(true);
    expect(player.subtitles).toHaveLength(2);
    expect(player.chapters).toEqual([{ start: 0, end: 60, title: "正片" }]);
  });

  it("reads and parses danmaku XML", async () => {
    const client = createBiliClient(
      route(
        () =>
          new Response(
            '<i><maxlimit>1000</maxlimit><d p="1,1,25,0,0,0,x,1,10">广告</d></i>',
            { status: 200, headers: { "content-type": "text/xml" } }
          )
      )
    );
    const danmaku = await client.getDanmaku(42);
    expect(danmaku.items[0]?.text).toBe("广告");
  });

  it("throws when danmaku returns JSON", async () => {
    const client = createBiliClient(
      route(() => json({ code: -352, message: "risk" }, 200))
    );
    await expect(client.getDanmaku(42)).rejects.toThrow(/code -352/);
  });

  it("fetches subtitle content without cookies", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      json({ body: [{ from: 1, to: 2, content: "第一句" }] })
    );
    const client = createBiliClient(fetchMock);
    const cues = await client.getSubtitle({ lan: "ai-zh", url: "//x/y.json" });
    expect(cues).toEqual([{ start: 1, end: 2, text: "第一句" }]);
    // 请求带超时信号，但绝不带 Cookie：字幕 CDN 会因 Cookie 拒绝 CORS。
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("请求卡住时按超时中止，不会无限期挂着", async () => {
    const fetchMock = vi.fn<FetchLike>(
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })) as FetchLike
    );
    const client = createBiliClient(fetchMock, { timeoutMs: 20 });
    await expect(client.getDanmaku(42)).rejects.toThrow();
  });
});

describe("多 P 视频的分 P 时长", () => {
  const multiPage = {
    code: 0,
    data: {
      cid: 11,
      title: "三分 P 视频",
      duration: 900,
      desc: "",
      pages: [
        { cid: 11, page: 1, part: "P1", duration: 300 },
        { cid: 12, page: 2, part: "P2", duration: 300 },
        { cid: 13, page: 3, part: "P3", duration: 300 }
      ]
    }
  };

  it("uses the selected page duration instead of the whole video duration", async () => {
    const client = createBiliClient(route(() => json(multiPage)));
    const result = await client.getVideo("BVmulti", 2);
    expect(result.cid).toBe(12);
    expect(result.duration).toBe(300);
  });

  it("falls back to data.duration when the page has no duration", async () => {
    const single = {
      code: 0,
      data: { cid: 11, title: "单 P", duration: 600, desc: "", pages: [{ cid: 11, page: 1, part: "P1" }] }
    };
    const client = createBiliClient(route(() => json(single)));
    const result = await client.getVideo("BVsingle", 1);
    expect(result.duration).toBe(600);
  });

  it("treats a missing page duration in a multi-page video as unknown", async () => {
    // 多 P 的 data.duration 是全部 P 之和，拿它当所选分 P 的时长会撑出错误时间轴。
    const mixed = {
      code: 0,
      data: {
        cid: 11,
        title: "两分 P",
        duration: 200,
        desc: "",
        pages: [
          { cid: 11, page: 1, part: "P1", duration: 100 },
          { cid: 12, page: 2, part: "P2" }
        ]
      }
    };
    const client = createBiliClient(route(() => json(mixed)));
    const result = await client.getVideo("BVmixed", 2);
    expect(result.cid).toBe(12);
    expect(result.duration).toBe(0);
  });

  it("throws when the requested page does not exist", async () => {
    const client = createBiliClient(route(() => json(multiPage)));
    await expect(client.getVideo("BVmulti", 9)).rejects.toBeInstanceOf(BiliApiError);
  });
});
