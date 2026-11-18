import { describe, expect, it } from "vitest";
import type { VideoKey } from "../../plugin/types";
import { videoKeyString } from "../video-key";

describe("视频标识字符串", () => {
  it("只由 site、videoId、partId 三段拼成", () => {
    const key: VideoKey = { site: "bilibili", videoId: "BV1", partId: "42" };
    expect(videoKeyString(key)).toBe("bilibili:BV1:42");
  });

  it("partId 不同就是不同的键", () => {
    const key: VideoKey = { site: "youtube", videoId: "abc", partId: "main" };
    expect(videoKeyString(key)).not.toBe(videoKeyString({ ...key, partId: "other" }));
  });
});
