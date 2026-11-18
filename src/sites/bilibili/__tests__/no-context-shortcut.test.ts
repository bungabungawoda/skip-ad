import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import type { PlayerInfo } from "../types";
import { makeClient, makeDeps, makeLlm } from "../../../../tests/helpers/analysis";

describe("analyzeVideo 在没有可读证据时不发 LLM 请求", () => {
  it("字幕与弹幕都为空时直接返回 no_context，不烧请求", async () => {
    const llm = makeLlm('{"segments":[]}');
    const client = makeClient({
      getPlayer: vi.fn(async (): Promise<PlayerInfo> => ({
        isLogin: true,
        subtitles: [],
        chapters: []
      })),
      getDanmaku: vi.fn(async () => ({ items: [] }))
    });
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ client, llm })
    );
    expect(result.warnings.some((warning) => warning.code === "no_context")).toBe(true);
    expect(result.segments).toEqual([]);
    // 没有字幕也没有弹幕时没有任何可判证据：逐块发请求只会白烧 LLM 配额。
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
