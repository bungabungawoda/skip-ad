import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import { LlmError } from "../../../core/ports/llm/client";
import type { LlmClient } from "../../../core/ports/llm/client";
import type { PlayerInfo } from "../types";
import { errorText } from "../../../core/lib/error";
import { cues, emptyTrack, foreignTrack, makeClient, makeDeps, makeLlm, track } from "../../../../tests/helpers/analysis";

function player(subtitles: PlayerInfo["subtitles"]): PlayerInfo {
  return { isLogin: true, subtitles, chapters: [] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorText — 任意抛出值", () => {
  it("Error 用 message，非 Error 用 fallback 或字符串化", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("offline", "网络不可用")).toBe("网络不可用");
    expect(errorText(42)).toBe("42");
    expect(errorText(null, "未知错误")).toBe("未知错误");
    expect(errorText(undefined)).toBe("undefined");
  });
});

describe("analyzeVideo 的错误与降级", () => {
  it("字幕列表不稳定时最多重试 3 次，间隔递增，拿到轨道即停", async () => {
    const attempts = [player([emptyTrack]), player([emptyTrack]), player([track])];
    const getPlayer = vi.fn(async () => attempts.shift() ?? player([track]));
    const sleeps: number[] = [];
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client: makeClient({ getPlayer }),
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      })
    );
    expect(getPlayer).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([400, 800]);
    expect(result.mode).toBe("full");
    expect(result.warnings.some((warning) => warning.code === "subtitle_missing")).toBe(false);
  });

  it("三次都拿不到字幕轨道就降级为仅弹幕，不再重试", async () => {
    const getPlayer = vi.fn(async () => player([emptyTrack]));
    const sleeps: number[] = [];
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client: makeClient({ getPlayer }),
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      })
    );
    expect(getPlayer).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([400, 800]);
    expect(result.mode).toBe("danmaku");
    expect(result.warnings.some((warning) => warning.code === "subtitle_missing")).toBe(true);
  });

  it("未登录且没有字幕轨时不重试：结论不会变，只是白等", async () => {
    const getPlayer = vi.fn(async (): Promise<PlayerInfo> => ({
      isLogin: false,
      subtitles: [],
      chapters: []
    }));
    const sleeps: number[] = [];
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client: makeClient({ getPlayer }),
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      })
    );
    expect(getPlayer).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(result.mode).toBe("danmaku");
    expect(result.warnings.map((warning) => warning.code)).toContain("not_logged_in");
  });

  it("播放器接口抛非 Error 值时给出可诊断的 partial 警告", async () => {
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client: makeClient({
          getPlayer: vi.fn(async () => {
            throw "wbi blocked";
          })
        })
      })
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "partial",
          message: "播放器信息读取失败：wbi blocked"
        })
      ])
    );
  });

  it("字幕与弹幕读取失败各自降级，消息带上原始错误文本", async () => {
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        client: makeClient({
          getSubtitle: vi.fn(async () => {
            throw new Error("cdn 403");
          }),
          getDanmaku: vi.fn(async () => {
            throw "socket closed";
          })
        })
      })
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "subtitle_fetch_failed", message: expect.stringContaining("cdn 403") }),
        expect.objectContaining({ code: "danmaku_missing", message: expect.stringContaining("socket closed") }),
        // 字幕与弹幕都没读到，不能显示成「仅弹幕」或「AD 0」。
        expect.objectContaining({ code: "no_context" })
      ])
    );
    expect(result.mode).toBe("danmaku");
  });

  it("LLM 认证失败时立刻停止后续分块，并给出 llm_failed", async () => {
    const failing: LlmClient = {
      complete: vi.fn(async () => {
        throw new LlmError("bad key", "auth");
      }),
    };
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ llm: failing })
    );
    expect(failing.complete).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((warning) => warning.code === "llm_failed")).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "partial")).toBe(false);
  });

  it("取消后不调用 LLM，并标注结果可能不完整", async () => {
    const llm = makeLlm();
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ llm, isCancelled: () => true })
    );
    expect(llm.complete).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "partial", message: "分析已取消，结果可能不完整" })
      ])
    );
  });

  it("字幕轨属于别的视频时不去读字幕，降级为仅弹幕并说明原因", async () => {
    const getSubtitle = vi.fn(async () => cues);
    const getPlayer = vi.fn(async () => player([foreignTrack]));
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ client: makeClient({ getPlayer, getSubtitle }) })
    );
    // 归属不符时先重试，三次都不符就不再碰字幕文件。
    expect(getPlayer).toHaveBeenCalledTimes(3);
    expect(getSubtitle).not.toHaveBeenCalled();
    expect(result.mode).toBe("danmaku");
    expect(result.warnings.some((warning) => warning.code === "subtitle_incomplete")).toBe(true);
    // 有轨道但不可信，不能报成「没有字幕」。
    expect(result.warnings.some((warning) => warning.code === "subtitle_missing")).toBe(false);
  });

  it("字幕只覆盖前半段也照用，不重试", async () => {
    // 只覆盖到 120 / 600 秒：片尾可能是音乐或空镜，本来就没有台词。
    const shortCues = cues.slice(0, 4);
    const getSubtitle = vi.fn(async () => shortCues);
    const getPlayer = vi.fn(async () => player([track]));
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ client: makeClient({ getPlayer, getSubtitle }) })
    );
    expect(getSubtitle).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("full");
    expect(result.warnings.some((warning) => warning.code === "subtitle_incomplete")).toBe(false);
  });

  it("字幕比视频还长时重试，三次都不对就降级为仅弹幕", async () => {
    // 结尾跑到 900 秒，视频只有 600 秒：只可能是别的更长视频的字幕。
    const tooLong = [...cues.slice(0, 4), { start: 700, end: 900, text: "别的视频的台词" }];
    const getSubtitle = vi.fn(async () => tooLong);
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({
        llm: makeLlm('{"segments":[]}'),
        client: makeClient({ getSubtitle })
      })
    );
    expect(getSubtitle).toHaveBeenCalledTimes(3);
    expect(result.mode).toBe("danmaku");
    expect(result.warnings.some((warning) => warning.code === "subtitle_incomplete")).toBe(true);
  });
});
