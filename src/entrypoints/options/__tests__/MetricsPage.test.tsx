// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MetricsPage } from "../MetricsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessage = vi.fn(async (request: { type: string }) => {
    if (request.type === "metrics.get") {
      return { ok: true, value: { skippedSegments: 3, savedSeconds: 125, undoCount: 1 } };
    }
    return { ok: true, value: null };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function renderPage(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MetricsPage />);
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
  return container;
}

describe("跳过统计页", () => {
  it("只显示累计段数、时长与撤销次数", async () => {
    const el = await renderPage();
    const text = el.textContent ?? "";
    expect(text).toContain("累计跳过的广告时长");
    expect(text).toContain("2");
    expect(text).toContain("分钟");
    expect(text).toContain("3 段");
    expect(text).toContain("2 分 5 秒");
    expect(text).toContain("1 次");
  });

  it("清空要点两次才发出请求，成功后回到全零", async () => {
    const el = await renderPage();
    const clear = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("清空统计")
    );
    expect(clear).toBeDefined();
    await act(async () => {
      clear?.click();
      await Promise.resolve();
    });
    expect(sendMessage.mock.calls.some(([request]) => request.type === "metrics.clear")).toBe(false);

    const confirm = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("再点一次确认清空")
    );
    await act(async () => {
      confirm?.click();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(sendMessage.mock.calls.some(([request]) => request.type === "metrics.clear")).toBe(true);
    expect(el.textContent).toContain("0 段");
  });

  it("读取失败时显示全零，不阻塞页面", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: { kind: "internal", message: "storage down" }
    });
    const el = await renderPage();
    expect(el.textContent).toContain("0 段");
  });
});
