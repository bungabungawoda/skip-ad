// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PrivacyPage } from "../PrivacyPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("隐私说明", () => {
  it("不承诺界面展示 Key 的最后四位", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<PrivacyPage onConfigure={() => {}} />));
    expect(container.textContent).toContain("界面不会完整显示 Key");
    expect(container.textContent).not.toContain("只显示最后四位");
  });

  it("不把读不到字幕说成没有发起分析", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<PrivacyPage onConfigure={() => {}} />));
    expect(container.textContent).toContain("没有可用字幕时不分析正文");
    expect(container.textContent).not.toContain("无字幕时不发起分析");
  });

  it("不承诺决策接口失败后自动改用另一个模型", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<PrivacyPage onConfigure={() => {}} />));
    expect(container.textContent).toContain("不会把内容自动转给另一个模型");
    expect(container.textContent).not.toContain("改用上面配置的模型");
  });
});
