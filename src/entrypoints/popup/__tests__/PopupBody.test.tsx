// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PopupBody } from "../PopupBody";
import { emptyUiState, type UiState } from "../../../core/ui/state";
import { sponsorSegment } from "../../../../tests/helpers/segments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ui(overrides: Partial<UiState> = {}): UiState {
  return { ...emptyUiState("https://www.youtube.com/watch?v=abc"), ...overrides };
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const handlers = {
  onShowList: () => {},
  onCommand: async () => true,
  onOpenSettings: () => {}
};

describe("PopupBody 按状态选卡片", () => {
  it("内容脚本没响应时提示刷新页面", () => {
    const el = render(
      <PopupBody phase="analyzing" ui={null} issue="no_script" showList={false} {...handlers} />
    );
    expect(el.textContent).toContain("内容脚本没有响应");
    expect(el.textContent).toContain("刷新视频页后重试");
  });

  it("不支持的页面提示支持范围", () => {
    const el = render(
      <PopupBody phase="analyzing" ui={null} issue="unsupported" showList={false} {...handlers} />
    );
    expect(el.textContent).toContain("当前页面不是支持的视频页");
  });

  it("未配置分析模型时显示配置入口", () => {
    const el = render(
      <PopupBody phase="no_key" ui={ui()} issue={null} showList={false} {...handlers} />
    );
    expect(el.textContent).toContain("未配置分析模型");
    expect(el.textContent).toContain("去配置");
  });

  it("失败状态显示错误类型与重试", () => {
    const el = render(
      <PopupBody
        phase="failed"
        ui={ui({
          error: { kind: "rate_limit", message: "429", elapsedMs: 1200, newSegments: 0 }
        })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("失败");
    expect(el.textContent).toContain("rate_limit");
    expect(el.textContent).toContain("重试分析");
  });

  it("失败时只提示手动重试，不再说明自动重试", () => {
    const el = render(
      <PopupBody phase="failed" ui={ui()} issue={null} showList={false} {...handlers} />
    );
    expect(el.textContent).not.toContain("正在自动重试");
    expect(el.textContent).toContain("重试");
  });

  it("结果不完整但有片段时在状态条下面提示", () => {
    const el = render(
      <PopupBody
        phase="ready"
        ui={ui({
          incomplete: true,
          segments: [{ segment: sponsorSegment(100, 120), policy: "auto" }]
        })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("结果不完整");
    expect(el.textContent).toContain("后面的内容没有判定");
  });

  it("权限问题显示授权入口", () => {
    const el = render(
      <PopupBody phase="permission" ui={ui()} issue={null} showList={false} {...handlers} />
    );
    expect(el.textContent).toContain("权限与授权");
    expect(el.textContent).toContain("去授权");
  });

  it("无字幕也无弹幕时说明没有可读内容，不显示仅弹幕", () => {
    const el = render(
      <PopupBody
        phase="no_context"
        ui={ui({ warnings: ["subtitle_missing", "no_context"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("无字幕也无弹幕");
    expect(el.textContent).toContain("没有读到字幕，也没有读到弹幕");
    expect(el.textContent).not.toContain("仅弹幕");
    expect(el.textContent).toContain("重新分析");
  });

  it("无字幕也无弹幕但站点有平台广告跳过时，说明平台广告不受影响", () => {
    const el = render(
      <PopupBody
        phase="no_context"
        ui={ui({
          warnings: ["subtitle_missing", "no_context"],
          platformAd: { phase: "no_ad", attempts: 0, appearance: 0 }
        })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("平台广告仍然会自动快进");
  });

  it("YouTube 没有字幕：只说没有字幕，不显示 B 站文案", () => {
    const el = render(
      <PopupBody
        phase="no_context"
        ui={ui({ site: "youtube", warnings: ["subtitle_missing", "no_context"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("没有字幕");
    expect(el.textContent).toContain("平台广告仍然会自动跳过");
    expect(el.textContent).not.toContain("无字幕也无弹幕");
    expect(el.textContent).not.toContain("仅弹幕");
    expect(el.textContent).not.toContain("AI 字幕轨");
  });

  it("YouTube 没读到播放器数据：说可能还有字幕，不冒充没有字幕", () => {
    const el = render(
      <PopupBody
        phase="source_unavailable"
        ui={ui({ site: "youtube", warnings: ["player_data_unavailable"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("没读到播放器数据");
    expect(el.textContent).toContain("视频可能有字幕");
    expect(el.textContent).toContain("重新分析");
    expect(el.textContent).not.toContain("没有字幕");
    expect(el.textContent).not.toContain("仅弹幕");
  });

  it("YouTube 字幕正文读取失败：说读取失败，不冒充没有字幕", () => {
    const el = render(
      <PopupBody
        phase="source_unavailable"
        ui={ui({ site: "youtube", warnings: ["transcript_fetch_failed"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("字幕读取失败");
    expect(el.textContent).toContain("正文没拉下来");
    expect(el.textContent).not.toContain("仅弹幕");
  });

  it("仅弹幕模式显示判定依据入口，没有片段时按钮禁用", () => {
    const el = render(
      <PopupBody
        phase="danmaku_only"
        ui={ui({ mode: "danmaku", warnings: ["not_logged_in", "subtitle_missing"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("未登录 · 仅弹幕");
    const button = el.querySelector("button");
    expect(button?.disabled).toBe(true);
  });

  it("字幕不属于本视频时，卡片说字幕不可信而不是未登录", () => {
    const el = render(
      <PopupBody
        phase="danmaku_only"
        ui={ui({ mode: "danmaku", warnings: ["subtitle_incomplete"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("字幕不可信 · 仅弹幕");
    expect(el.textContent).toContain("不属于这条视频");
    expect(el.textContent).not.toContain("未登录");
  });

  it("字幕读取失败时，卡片说读取失败", () => {
    const el = render(
      <PopupBody
        phase="danmaku_only"
        ui={ui({ mode: "danmaku", warnings: ["subtitle_fetch_failed"] })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("字幕读取失败 · 仅弹幕");
  });

  it("有片段但字幕不可信时，状态条下面说明只用弹幕", () => {
    const el = render(
      <PopupBody
        phase="ready"
        ui={ui({
          mode: "danmaku",
          durationSec: 300,
          warnings: ["subtitle_incomplete"],
          segments: [{ segment: sponsorSegment(10, 20), policy: "auto" }]
        })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("字幕不可信");
    expect(el.textContent).toContain("只用弹幕");
    expect(el.textContent).toContain("1 个片段");
  });

  it("字幕正常时不显示字幕不可信提示", () => {
    const el = render(
      <PopupBody
        phase="ready"
        ui={ui({
          mode: "full",
          durationSec: 300,
          segments: [{ segment: sponsorSegment(10, 20), policy: "auto" }]
        })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).not.toContain("字幕不可信");
  });

  it("已就绪时显示标题、片段列表与本地统计", () => {
    const el = render(
      <PopupBody
        phase="ready"
        ui={ui({
          title: "测试视频",
          durationSec: 300,
          cacheKey: "bilibili:BV1:42:bilibili:1:m:v1",
          platformAd: { phase: "fast_forwarding", attempts: 1, appearance: 1 },
          segments: [{ segment: sponsorSegment(10, 20), policy: "auto" }]
        })}
        issue={null}
        showList
        {...handlers}
      />
    );
    expect(el.textContent).toContain("测试视频");
    expect(el.textContent).toContain("商单");
    expect(el.textContent).toContain("跳到结尾");
    expect(el.textContent).toContain("已缓存 5 分钟");
    expect(el.textContent).toContain("广告快进中");
  });

  it("片段理由被截断时，悬停显示完整内容", () => {
    const reason = "这段在口播赞助商，展示产品并给出购买口令";
    const el = render(
      <PopupBody
        phase="ready"
        ui={ui({
          durationSec: 300,
          segments: [{ segment: sponsorSegment(10, 20, { reason }), policy: "auto" }]
        })}
        issue={null}
        showList
        {...handlers}
      />
    );
    const line = [...el.querySelectorAll("span")].find((node) =>
      node.textContent?.startsWith("置信度 0.90")
    );
    expect(line?.textContent).toContain(reason);
    expect(line?.getAttribute("title")).toBeNull();
    expect(line?.className).toContain("cursor-help");
    act(() => {
      line?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(`置信度 0.90 · 自动跳 · ${reason}`);
    expect(line?.getAttribute("aria-describedby")).toBe(tooltip?.id);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeTruthy();
    act(() => {
      line?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("无片段提示不放在会收缩的列表滚动区里", () => {
    const el = render(
      <PopupBody
        phase="no_ads"
        ui={ui({
          durationSec: 300,
          segments: []
        })}
        issue={null}
        showList
        {...handlers}
      />
    );
    const message = [...el.querySelectorAll("p")].find((node) =>
      node.textContent?.includes("这条视频没有判定出推广片段")
    );
    expect(message).toBeTruthy();
    expect(message?.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  });

  it("分析中显示进度与取消", () => {
    const el = render(
      <PopupBody
        phase="analyzing"
        ui={ui({ progress: { done: 1, total: 4 } })}
        issue={null}
        showList={false}
        {...handlers}
      />
    );
    expect(el.textContent).toContain("已读完 1 / 4 段");
    expect(el.textContent).toContain("取消分析");
  });
});

