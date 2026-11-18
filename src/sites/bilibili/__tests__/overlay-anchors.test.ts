// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createBilibiliAdapter } from "../adapter";

/**
 * 进度条锚点：有章节的视频里 B 站把每个章节渲染成
 * .bpx-player-progress-schedule-segment，主轨道只剩 wrap。
 * 锚点必须两种页面都命中同一个节点，否则色块层静默不挂载。
 */

function buildPlayer(chapters: number): void {
  const container = document.createElement("div");
  container.className = "bpx-player-container";
  const bar = document.createElement("div");
  bar.className = "bpx-player-progress";
  const wrap = document.createElement("div");
  wrap.className = "bpx-player-progress-schedule-wrap";

  if (chapters === 0) {
    const schedule = document.createElement("div");
    schedule.className = "bpx-player-progress-schedule";
    wrap.append(schedule);
  } else {
    for (let index = 0; index < chapters; index += 1) {
      const segment = document.createElement("div");
      segment.className =
        "bpx-player-progress-schedule bpx-player-progress-schedule-segment";
      wrap.append(segment);
    }
  }

  bar.append(wrap);
  container.append(bar);
  document.body.append(container);
}

function resolveAnchor(selector: string): Element | null {
  const anchor = document.querySelector(".bpx-player-container");
  return anchor?.querySelector(selector) ?? document.querySelector(selector);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("哔哩哔哩进度条锚点", () => {
  it("有章节时命中主轨道 wrap，而不是章节分段", () => {
    buildPlayer(4);
    const overlay = createBilibiliAdapter().overlay;
    expect(overlay).toBeDefined();

    const track = resolveAnchor(overlay!.progressAnchor);
    expect(track?.className).toBe("bpx-player-progress-schedule-wrap");
    expect(track?.parentElement?.className).toBe("bpx-player-progress");
  });

  it("没有章节时也命中同一个 wrap", () => {
    buildPlayer(0);
    const overlay = createBilibiliAdapter().overlay;

    const track = resolveAnchor(overlay!.progressAnchor);
    expect(track?.className).toBe("bpx-player-progress-schedule-wrap");
  });

  it("胶囊宿主是进度条本体，不会被章节裁切", () => {
    buildPlayer(4);
    const overlay = createBilibiliAdapter().overlay;

    const host = resolveAnchor(overlay!.snapAnchor ?? "");
    expect(host?.className).toBe("bpx-player-progress");
    expect(host?.contains(resolveAnchor(overlay!.progressAnchor))).toBe(true);
  });
});
