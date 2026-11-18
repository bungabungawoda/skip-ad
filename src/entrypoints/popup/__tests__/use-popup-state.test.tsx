// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { JSX } from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePopupState } from "../use-popup-state";
import { emptyUiState, type UiState } from "../../../core/ui/state";
import { DEFAULT_POLICY } from "../../../core/policy/policy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function probeState(): UiState {
  return { ...emptyUiState("https://www.bilibili.com/video/BV1"), phase: "ready" };
}

function Probe(): JSX.Element {
  const state = usePopupState();
  const [result, setResult] = useState<string>("");
  return (
    <div>
      <span data-testid="phase">{state.ui?.phase ?? "none"}</span>
      <span data-testid="issue">{state.issue ?? ""}</span>
      <span data-testid="site">{String(state.siteAuthorized)}</span>
      <span data-testid="endpoint">{String(state.endpointAuthorized)}</span>
      <span data-testid="error">{state.commandError ?? ""}</span>
      <span data-testid="result">{result}</span>
      <button
        type="button"
        onClick={() => void state.runCommand("reanalyze").then((ok) => setResult(String(ok)))}
      >
        go
      </button>
    </div>
  );
}

function stubChrome(options: {
  tab?: { id?: number; url?: string };
  uiResponse?: unknown;
  commandResponse?: unknown;
  permissionsThrow?: boolean;
  settings?: Record<string, unknown>;
  onPermissions?: (origins: string[]) => boolean;
}): void {
  const uiResponse = options.uiResponse ?? { ok: true, value: probeState() };
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => (options.tab ? [options.tab] : [])),
      sendMessage: vi.fn(async (tabId: number, request: { type: string }) =>
        request.type === "ui.getState" ? uiResponse : (options.commandResponse ?? uiResponse)
      )
    },
    runtime: {
      sendMessage: vi.fn(async (request: { type: string }) =>
        request.type === "settings.get"
          ? {
              ok: true,
              value: options.settings ?? {
              policy: DEFAULT_POLICY,
              llmConfigured: true,
              siteSwitches: { enabled: true, platformAdSkip: true, segmentAnalysis: true }
            }
            }
          : { ok: true, value: null }
      )
    },
    permissions: {
      contains: vi.fn(async (request: { origins?: string[] }) => {
        if (options.permissionsThrow) throw new Error("no permission api");
        const origins = request.origins ?? [];
        return options.onPermissions ? options.onPermissions(origins) : true;
      })
    }
  });
}

async function renderProbe(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return container;
}

function text(el: HTMLElement, testId: string): string {
  return el.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

beforeEach(() => {
  stubChrome({ tab: { id: 1, url: "https://www.bilibili.com/video/BV1" } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePopupState", () => {
  it("拉到内容脚本快照后写入 ui，并检查站点权限", async () => {
    const el = await renderProbe();
    expect(text(el, "phase")).toBe("ready");
    expect(text(el, "issue")).toBe("");
    expect(text(el, "site")).toBe("true");
  });

  it("内容脚本没响应时标记 no_script", async () => {
    stubChrome({
      tab: { id: 1, url: "https://www.bilibili.com/video/BV1" },
      uiResponse: { ok: false, error: { kind: "no_content_script", message: "no" } }
    });
    const el = await renderProbe();
    expect(text(el, "issue")).toBe("no_script");
  });

  it("不是支持的页面时标记 unsupported", async () => {
    stubChrome({ tab: { id: 1, url: "https://example.com/" } });
    const el = await renderProbe();
    expect(text(el, "issue")).toBe("unsupported");
  });

  it("权限查询失败按未授权处理", async () => {
    stubChrome({
      tab: { id: 1, url: "https://www.bilibili.com/video/BV1" },
      permissionsThrow: true
    });
    const el = await renderProbe();
    expect(text(el, "site")).toBe("false");
  });

  it("端点带端口时按去端口的模式查询，端点失败不推翻站点授权", async () => {
    const seen: string[][] = [];
    stubChrome({
      tab: { id: 1, url: "https://www.bilibili.com/video/BV1" },
      settings: {
        policy: DEFAULT_POLICY,
        llmConfigured: true,
        siteSwitches: { enabled: true, platformAdSkip: true, segmentAnalysis: true },
        endpointOrigin: "http://127.0.0.1:1234"
      },
      onPermissions: (origins) => {
        seen.push(origins);
        // 端点查询失败只影响端点结论，不能把站点授权一起推翻。
        if (origins.includes("http://127.0.0.1/*")) throw new Error("endpoint unavailable");
        return true;
      }
    });
    const el = await renderProbe();
    expect(seen).toContainEqual(["http://127.0.0.1/*"]);
    // 站点查询不受端点查询影响。
    expect(text(el, "site")).toBe("true");
    expect(text(el, "endpoint")).toBe("false");
  });

  it("命令失败时把原因暴露给界面", async () => {
    stubChrome({
      tab: { id: 1, url: "https://www.bilibili.com/video/BV1" },
      commandResponse: { ok: false, error: { kind: "no_content_script", message: "刷新页面" } }
    });
    const el = await renderProbe();
    await act(async () => {
      el.querySelector("button")?.click();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(text(el, "error")).toBe("刷新页面");
    expect(text(el, "result")).toBe("false");
  });

  it("命令成功时返回 true", async () => {
    const el = await renderProbe();
    await act(async () => {
      el.querySelector("button")?.click();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(text(el, "result")).toBe("true");
  });
});
