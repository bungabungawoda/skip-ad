/** 可控的假 video：真 DOM 元素，属性可写，配合 tick 模拟播放器的一帧。 */
export function makeVideo(currentTime = 0, duration = 600): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  Object.defineProperty(video, "currentTime", {
    value: currentTime,
    writable: true,
    configurable: true
  });
  Object.defineProperty(video, "paused", { value: false, writable: true, configurable: true });
  Object.defineProperty(video, "seeking", { value: false, writable: true, configurable: true });
  return video;
}

/** 推进播放位置并触发 timeupdate。 */
export function tick(video: HTMLVideoElement, currentTime: number): void {
  video.currentTime = currentTime;
  video.dispatchEvent(new Event("timeupdate"));
}
