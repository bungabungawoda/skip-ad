import { afterEach, describe, expect, it, vi } from "vitest";
import { createBilibiliAdapter } from "../adapter";
import type { AnalysisServices } from "../../../core/plugin/types";
import { createStorageCache } from "../../../core/ports/cache/store";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import type { LlmClient } from "../../../core/ports/llm/client";

/**
 * 适配器接线：内容脚本只能通过 SiteAdapter.createSegmentAnalyzer 拿到站点分析器。
 * 这个测试不直接调用 analyzeVideo，而是从适配器入口走完整分析，暴露“分析器未接线”的问题。
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function xml(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/xml" }
  });
}

function makeFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/x/web-interface/view")) {
      return json({
        code: 0,
        data: {
          aid: 9001,
          cid: 42,
          title: "接线测试视频",
          duration: 600,
          desc: "本期由赞助商提供",
          owner: { name: "UP" },
          pages: [{ cid: 42, page: 1, part: "P1", duration: 600 }]
        }
      });
    }
    if (url.includes("/x/player/wbi/v2")) {
      return json({
        code: 0,
        data: {
          login_mid: 1,
          subtitle: {
            subtitles: [
              {
                lan: "ai-zh",
                lan_doc: "中文",
                subtitle_url:
                  "https://aisubtitle.example/bfs/ai_subtitle/prod/9001426ec41b1bf1db.json"
              }
            ]
          },
          view_points: []
        }
      });
    }
    if (url.includes("/x/v1/dm/list.so")) return xml("<i></i>");
    if (url.includes("aisubtitle.example")) {
      return json({
        body: [
          { from: 90, to: 95, content: "接下来是广告时间" },
          { from: 95, to: 100, content: "本期视频由赞助商提供" },
          { from: 100, to: 110, content: "点击简介链接领取福利" },
          { from: 110, to: 120, content: "感谢赞助商" },
          // 覆盖到 598 / 600 秒，过字幕覆盖率校验。
          { from: 588, to: 598, content: "今天就聊到这里" }
        ]
      });
    }
    throw new Error(`测试没有为请求准备响应：${url}`);
  }) as unknown as typeof fetch;
}

function makeServices(llm: LlmClient): AnalysisServices {
  return {
    llm,
    cache: createStorageCache(createMemoryStorageArea(), () => 1_000),
    readSettings: async () => ({
      policy: DEFAULT_POLICY,
      llmConfigured: true,
      decisionConfigured: false,
      analysisConfigured: true,
      model: "test-model",
      siteSwitches: {}
    })
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("哔哩哔哩适配器必须提供分析器工厂", () => {
  it("createSegmentAnalyzer 存在，且完整分析能产出片段", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const llm: LlmClient = {
      complete: vi.fn(async () =>
        '{"segments":[{"start":100,"end":120,"kind":"sponsor","confidence":0.95,"evidence":["本期视频由赞助商提供"],"reason":"口播赞助"}]}'
      ),
    };
    const adapter = createBilibiliAdapter();

    // 内容脚本拿到 null 时不会发起任何分析，这里必须能从适配器拿到工厂。
    expect(adapter.createSegmentAnalyzer).toBeTypeOf("function");

    const analyzer = adapter.createSegmentAnalyzer?.(makeServices(llm));
    expect(analyzer).toBeDefined();
    const result = await analyzer!.analyze({
      video: { site: "bilibili", videoId: "BV1test", partId: "1" },
      currentTime: 0,
      signal: new AbortController().signal
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 120, kind: "sponsor" });
    expect(result.video.partId).toBe("42");
  });
});
