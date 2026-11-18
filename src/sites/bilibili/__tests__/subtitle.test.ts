import { describe, expect, it } from "vitest";
import {
  chooseSubtitleTrack,
  lastCueEnd,
  normalizeSubtitleUrl,
  parseSubtitlePayload,
  pickSubtitleTrack,
  subtitleOutrunsVideo,
  subtitleTrackOwnership
} from "../api/subtitle";

const AID = 117_416_201_815_207;
const CID = 42_622_387_960;

/** 线上形态：basename = <aid><cid><hash>。 */
const ownedTrack = {
  lan: "ai-zh",
  label: "中文",
  url: `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${AID}${CID}6ec41b1bf1db.json?auth_key=1`
};

const foreignTrack = {
  lan: "ai-zh",
  label: "中文",
  url: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/113084375109318257497512148be901d2.json?auth_key=1"
};

/** 人工字幕文件名是纯 hash，读不出归属。 */
const manualTrack = {
  lan: "zh-cn",
  label: "中文（人工）",
  url: "https://i0.hdslb.com/bfs/subtitle/5f2c1e9a.json"
};

describe("subtitle helpers", () => {
  it("prefers Chinese AI subtitles and skips tracks without URLs", () => {
    const chosen = chooseSubtitleTrack([
      { lan: "ai-en", url: "//example.com/en.json" },
      { lan: "zh-CN", url: "" },
      { lan: "ai-zh", url: "//example.com/zh.json" }
    ]);
    expect(chosen?.lan).toBe("ai-zh");
  });

  it("falls back to any usable track", () => {
    expect(
      chooseSubtitleTrack([{ lan: "ai-en", url: "//example.com/en.json" }])
        ?.lan
    ).toBe("ai-en");
    expect(chooseSubtitleTrack([{ lan: "ai-zh", url: "" }])).toBeUndefined();
  });

  it("normalizes protocol-relative URLs", () => {
    expect(normalizeSubtitleUrl("//aisubtitle.hdslb.com/a.json")).toBe(
      "https://aisubtitle.hdslb.com/a.json"
    );
    expect(normalizeSubtitleUrl(" https://x/y ")).toBe("https://x/y");
  });

  it("parses subtitle bodies and drops invalid cues", () => {
    const cues = parseSubtitlePayload({
      body: [
        { from: 1, to: 2.5, content: "第一句" },
        { from: "3", to: "4", content: "第二句" },
        { from: 5, to: 4, content: "倒置" },
        { from: 6, to: 7, content: "   " }
      ]
    });
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: "第一句" },
      { start: 3, end: 4, text: "第二句" }
    ]);
  });

  it("throws when the payload has no body", () => {
    expect(() => parseSubtitlePayload(null)).toThrow();
    expect(() => parseSubtitlePayload({})).toThrow();
  });
});

describe("字幕轨归属与长度校验", () => {
  it("只接受文件名前缀等于 aid+cid 的轨道", () => {
    expect(pickSubtitleTrack([foreignTrack], AID, CID)).toBeUndefined();
    expect(pickSubtitleTrack([foreignTrack, ownedTrack], AID, CID)).toMatchObject({
      url: ownedTrack.url
    });
  });

  it("读不出归属的人工字幕放行，避免把正常字幕误判成串数据", () => {
    expect(pickSubtitleTrack([manualTrack], AID, CID)).toMatchObject({ url: manualTrack.url });
  });

  it("归属分三档：自己的、读不出的、别人的", () => {
    expect(subtitleTrackOwnership(ownedTrack, AID, CID)).toBe("owned");
    expect(subtitleTrackOwnership(manualTrack, AID, CID)).toBe("unknown");
    expect(subtitleTrackOwnership(foreignTrack, AID, CID)).toBe("foreign");
    // aid 读不到时不做归属判断。
    expect(subtitleTrackOwnership(ownedTrack, 0, CID)).toBe("unknown");
  });

  it("只把「字幕比视频还长」当成异常，比视频短是正常的", () => {
    const cues = [
      { start: 0, end: 50, text: "前半段" },
      { start: 50, end: 60, text: "说到 60 秒就停了" }
    ];
    expect(lastCueEnd(cues)).toBe(60);
    // 片尾没人说话：字幕只到 60 / 100 秒，不算异常。
    expect(subtitleOutrunsVideo(cues, 100)).toBe(false);
    // 1.2 倍以内放行，超过就当成别的更长视频的字幕。
    expect(subtitleOutrunsVideo(cues, 50)).toBe(false);
    expect(subtitleOutrunsVideo(cues, 40)).toBe(true);
    // 时长读不到（0）时无法判断，不拦。
    expect(subtitleOutrunsVideo(cues, 0)).toBe(false);
    expect(lastCueEnd([])).toBe(0);
  });

  it("长视频按比例放得太宽，超出 5 分钟照样拦", () => {
    const cues = [{ start: 0, end: 2101, text: "结尾" }];
    // 1800 秒的 1.2 倍是 2160 秒，但最多只允许多 5 分钟（2100 秒）。
    expect(subtitleOutrunsVideo(cues, 1800)).toBe(true);
    expect(subtitleOutrunsVideo([{ start: 0, end: 2100, text: "刚好" }], 1800)).toBe(false);
  });
});
