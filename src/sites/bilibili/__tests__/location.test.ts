import { describe, expect, it } from "vitest";
import { parseVideoLocation } from "../adapter";

describe("parseVideoLocation", () => {
  it("reads bvid and page from a video URL", () => {
    expect(
      parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001?p=3")
    ).toEqual({ bvid: "BVSynthetic001", page: 3 });
  });

  it("defaults to the first page", () => {
    expect(parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001/")).toEqual({
      bvid: "BVSynthetic001",
      page: 1
    });
    expect(
      parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001?p=abc")
    ).toEqual({ bvid: "BVSynthetic001", page: 1 });
  });

  it("reads bvid from a watchlater list URL", () => {
    expect(
      parseVideoLocation(
        "https://www.bilibili.com/list/watchlater?oid=100000001&bvid=BVSynthetic002"
      )
    ).toEqual({ bvid: "BVSynthetic002", page: 1 });
  });

  it("reads page from a list URL", () => {
    expect(
      parseVideoLocation("https://www.bilibili.com/list/watchlater?bvid=BVSynthetic002&p=2")
    ).toEqual({ bvid: "BVSynthetic002", page: 2 });
  });

  it("rejects list URLs without a valid bvid", () => {
    expect(parseVideoLocation("https://www.bilibili.com/list/watchlater?oid=123")).toBeNull();
    expect(parseVideoLocation("https://www.bilibili.com/list/watchlater?bvid=abc")).toBeNull();
  });

  it("rejects other sites and paths", () => {
    expect(parseVideoLocation("https://m.bilibili.com/video/BVSynthetic001")).toBeNull();
    expect(parseVideoLocation("https://www.bilibili.com/bangumi/play/ep123")).toBeNull();
    expect(parseVideoLocation("not a url")).toBeNull();
  });

  it("treats non-positive p as the first page and keeps the BV prefix case-sensitive", () => {
    expect(parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001?p=0")).toEqual({
      bvid: "BVSynthetic001",
      page: 1
    });
    expect(parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001?p=-2")).toEqual({
      bvid: "BVSynthetic001",
      page: 1
    });
    expect(parseVideoLocation("https://www.bilibili.com/video/bvSynthetic001")).toBeNull();
    // 现状：/video/BV 之后的额外路径段仍按同一视频处理。
    expect(parseVideoLocation("https://www.bilibili.com/video/BVSynthetic001/extra")).toEqual({
      bvid: "BVSynthetic001",
      page: 1
    });
  });
});
