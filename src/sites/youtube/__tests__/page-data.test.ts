// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { captionTracksFromResponse } from "../transcript";
import { readVerifiedDuration } from "../metadata";
import {
  readLengthSeconds,
  readPlayerResponse,
  readPlayerResponseForVideo
} from "../page-data";

/**
 * 内容脚本默认在隔离世界运行，读不到页面主世界的 window.ytInitialPlayerResponse。
 * 这里刻意不设置 window 全局，只放页面里真实存在的内联 script，模拟隔离世界的可访问范围。
 */

const PLAYER_RESPONSE = {
  videoDetails: {
    videoId: "abc",
    title: "隔离世界测试视频",
    author: "频道",
    lengthSeconds: 600
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en",
          languageCode: "en",
          kind: "asr",
          name: { simpleText: "English (auto)" }
        }
      ]
    }
  }
};

function mountInlinePlayerResponse(): void {
  const script = document.createElement("script");
  script.textContent = `var ytInitialPlayerResponse = ${JSON.stringify(PLAYER_RESPONSE)};`;
  document.body.append(script);
}

function mountVideoWithDuration(duration: number): void {
  const video = document.createElement("video");
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  document.body.append(video);
}

function mountFlexyVideoId(videoId: string): void {
  const flexy = document.createElement("ytd-watch-flexy");
  flexy.setAttribute("video-id", videoId);
  document.body.append(flexy);
}

function mountPlayerContainer(showingAd: boolean): void {
  const player = document.createElement("div");
  player.id = "movie_player";
  if (showingAd) player.classList.add("ad-showing");
  document.body.append(player);
}

afterEach(() => {
  delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  document.body.innerHTML = "";
  document.title = "";
});

describe("YouTube 页面数据读取（隔离世界）", () => {
  it("没有 window 全局时，从内联 script 读取字幕轨", () => {
    mountInlinePlayerResponse();
    const tracks = captionTracksFromResponse(readPlayerResponse());
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ lang: "en", isAuto: true });
  });

  it("只认属于当前视频的内联快照", () => {
    mountInlinePlayerResponse();
    expect(readPlayerResponseForVideo("abc")).toBeDefined();
    expect(readPlayerResponseForVideo("other")).toBeUndefined();
    expect(readLengthSeconds(readPlayerResponseForVideo("abc"))).toBe(600);
    expect(readLengthSeconds(readPlayerResponseForVideo("other"))).toBeUndefined();
  });

});

describe("readVerifiedDuration — 只信核对过的时长", () => {
  it("内联播放器数据属于当前视频：用内联时长", () => {
    mountInlinePlayerResponse();
    expect(readVerifiedDuration(document, "abc")).toBe(600);
    expect(readVerifiedDuration(document, "other")).toBeUndefined();
  });

  it("页面 video-id 与请求一致：用 video 的时长", () => {
    mountVideoWithDuration(600);
    mountFlexyVideoId("abc");
    expect(readVerifiedDuration(document, "abc")).toBe(600);
  });

  it("页面 video-id 还是上一条视频：不用旧时长裁字幕", () => {
    mountVideoWithDuration(600);
    mountFlexyVideoId("stale");
    expect(readVerifiedDuration(document, "abc")).toBeUndefined();
  });

  it("正在放广告：video 时长是广告的，不能用", () => {
    mountVideoWithDuration(30);
    mountFlexyVideoId("abc");
    mountPlayerContainer(true);
    expect(readVerifiedDuration(document, "abc")).toBeUndefined();
  });

  it("页面还没写出 video-id：不用 video 的时长", () => {
    mountVideoWithDuration(600);
    mountPlayerContainer(false);
    expect(readVerifiedDuration(document, "abc")).toBeUndefined();
  });
});

