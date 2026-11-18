// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import plugin from "../index";
import { resolveYouTubeVideo } from "../adapter";

/** 网站契约测试：URL 匹配、VideoKey 解析、播放器定位、取消与降级。 */

describe("YouTube 网站契约", () => {
  it("match 只接受 watch 页，来自 site.json 的同一份声明", () => {
    expect(plugin.id).toBe("youtube");
    expect(plugin.match(new URL("https://www.youtube.com/watch?v=abc"))).toBe(true);
    expect(plugin.match(new URL("https://www.youtube.com/watch"))).toBe(true);
    expect(plugin.match(new URL("https://www.youtube.com/"))).toBe(false);
    expect(plugin.match(new URL("https://www.youtube.com/feed/subscriptions"))).toBe(false);
    expect(plugin.match(new URL("https://www.bilibili.com/video/BV1xx"))).toBe(false);
    expect(plugin.match(new URL("https://m.youtube.com/watch?v=abc"))).toBe(false);
  });

  it("VideoKey：videoId 取 v 参数，partId 固定 main；非法输入返回 null", () => {
    expect(resolveYouTubeVideo(new URL("https://www.youtube.com/watch?v=abc&t=30s"))).toEqual({
      site: "youtube",
      videoId: "abc",
      partId: "main"
    });
    expect(resolveYouTubeVideo(new URL("https://www.youtube.com/watch"))).toBeNull();
    expect(resolveYouTubeVideo(new URL("https://www.youtube.com/embed/abc"))).toBeNull();
    expect(resolveYouTubeVideo(new URL("https://example.com/watch?v=abc"))).toBeNull();
  });

  it("播放器定位：容器内 video 优先，容器缺失时退回页面 video", () => {
    document.body.innerHTML = "";
    const adapter = plugin.create();
    // 容器缺失：退回页面级 video。
    const looseVideo = document.createElement("video");
    document.body.append(looseVideo);
    expect(adapter.player.findVideo()).toBe(looseVideo);

    // 容器出现：定位容器内的 video。
    const container = document.createElement("div");
    container.id = "movie_player";
    const innerVideo = document.createElement("video");
    container.append(innerVideo);
    document.body.append(container);
    expect(adapter.player.findVideo()).toBe(innerVideo);
  });

  it("提供浮层挂载点：进度条色块与撤销 Toast 才有地方挂", () => {
    const adapter = plugin.create();
    // 浮层挂载失败只影响提示，不影响自动跳；这里钉住挂载点不被误删。
    expect(adapter.overlay).toEqual({
      anchor: ".html5-video-player",
      progressAnchor: ".ytp-progress-bar",
      snapAnchor: ".ytp-progress-bar",
      progressMarksZIndex: 42
    });
  });

  it("状态降级：播放器缺失时广告状态未知，快进返回 acted=false", () => {
    document.body.innerHTML = "";
    const adapter = plugin.create();
    const adAdapter = adapter.createPlatformAdController?.();
    expect(adAdapter?.observe()).toBeNull();
    expect(adAdapter?.fastForward()).toEqual({ acted: false });
  });
});
