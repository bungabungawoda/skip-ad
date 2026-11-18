// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../App";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";

vi.mock("motion/react", async () => {
  const React = await import("react");
  const Div = React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
    const rest = { ...props };
    for (const key of ["variants", "initial", "animate", "exit", "custom", "transition"]) {
      delete rest[key];
    }
    return React.createElement("div", { ...rest, ref });
  });
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: { div: Div },
    useReducedMotion: () => true
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let area: ReturnType<typeof createMemoryStorageArea>;

beforeEach(() => {
  area = createMemoryStorageArea();
  vi.stubGlobal("chrome", {
    storage: { local: { get: area.get, set: area.set, remove: area.remove } },
    runtime: {
      sendMessage: vi.fn(async (request: { type: string }) =>
        request.type === "settings.get"
          ? { ok: true, value: { llmConfigured: true, policy: null, siteSwitches: {} } }
          : { ok: true, value: null }
      ),
      openOptionsPage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) }
  });
  class ResizeObserverStub {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.callback();
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // 用窄屏布局渲染：不需要等分栏测量，也能覆盖导航与页面切换。
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as MediaQueryList
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 800,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderApp(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
    // 等 zustand persist 完成 hydration、ResizeObserver 回调写入宽度。
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("Options App", () => {
  it("默认落在模型连接页，导航可以切到站点页", async () => {
    const el = await renderApp();
    expect(el.textContent).toContain("模型连接");

    const menu = el.querySelector<HTMLButtonElement>('button[aria-label="打开设置导航"]');
    expect(menu).not.toBeNull();
    await act(async () => {
      menu?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const siteNav = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "站点"
    );
    expect(siteNav).toBeDefined();
    await act(async () => {
      siteNav?.click();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(el.textContent).toContain("每个网站的开关独立生效");
  });

  it("没有配置 Key 时首次打开落在隐私页", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: area.get, set: area.set, remove: area.remove } },
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: true,
          value: { llmConfigured: false, policy: null, siteSwitches: {} }
        })),
        openOptionsPage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) }
    });
    const el = await renderApp();
    expect(el.textContent).toContain("只在支持的网站工作");
  });
});
