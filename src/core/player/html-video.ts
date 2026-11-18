import type { PlayerAdapter } from "../plugin/types";

/** 通用 video 查找：与各站播放器容器解耦，容器选择器留给站点适配器。 */
export function createHtmlVideoPlayer(): PlayerAdapter {
  return {
    findVideo() {
      return document.querySelector<HTMLVideoElement>("video");
    }
  };
}
