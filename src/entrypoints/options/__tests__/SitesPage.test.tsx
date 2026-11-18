// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SitesPage } from "../SitesPage";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let area: ReturnType<typeof createMemoryStorageArea>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  area = createMemoryStorageArea();
  sendMessage = vi.fn(async (request: { type: string; patch?: unknown }) =>
    request.type === "settings.setSiteSwitches"
      ? {
          ok: true,
          value: Object.fromEntries(
            Object.entries(request.patch as Record<string, Record<string, unknown>>).map(
              ([siteId, patch]) => [
                siteId,
                { enabled: true, platformAdSkip: true, segmentAnalysis: true, ...patch }
              ]
            )
          )
        }
      : { ok: true, value: null }
  );
  vi.stubGlobal("chrome", {
    storage: { local: { get: area.get, set: area.set, remove: area.remove } },
    runtime: {
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
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
    root?.render(<SitesPage />);
    await Promise.resolve();
  });
  return container;
}

describe("SitesPage", () => {
  it("站点清单来自 site.json：两站各自显示支持的开关", async () => {
    const el = await renderPage();
    expect(el.textContent).toContain("哔哩哔哩");
    expect(el.textContent).toContain("YouTube");
    // 哔哩哔哩没有平台广告：2 个开关；YouTube 有：3 个开关。
    expect(el.querySelectorAll('[role="switch"]')).toHaveLength(5);
  });

  it("同一帧内连续切两个站点的开关，两次改动都会保存", async () => {
    const el = await renderPage();
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      switches[0]?.click();
      switches[2]?.click();
      await Promise.resolve();
    });
    const calls = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "settings.setSiteSwitches"
    );
    const patches = calls.map(
      (call) => (call[0] as { patch: Record<string, { enabled: boolean }> }).patch
    );
    expect(patches[0]?.bilibili?.enabled).toBe(false);
    expect(patches[1]?.youtube?.enabled).toBe(false);
  });

  it("关闭站点总开关时一并关掉该站其它能力并保存", async () => {
    const el = await renderPage();
    const first = el.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      first?.click();
      await Promise.resolve();
    });
    const saved = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "settings.setSiteSwitches"
    )?.[0] as { patch: Record<string, { enabled: boolean; segmentAnalysis: boolean }> };
    expect(saved.patch.bilibili?.enabled).toBe(false);
    expect(saved.patch.bilibili?.segmentAnalysis).toBe(false);
  });

  it("读取完成前开关全部禁用", async () => {
    const pending = new Promise<Record<string, unknown>>(() => undefined);
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => pending), set: area.set, remove: area.remove } },
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    const el = await renderPage();
    for (const toggle of el.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
      expect(toggle.disabled).toBe(true);
    }
  });

  it("读取失败时显示原因，开关保持禁用", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error("storage 读失败");
          }),
          set: area.set,
          remove: area.remove
        }
      },
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    const el = await renderPage();
    expect(el.textContent).toContain("读取站点开关失败");
    for (const toggle of el.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
      expect(toggle.disabled).toBe(true);
    }
  });

  it("保存失败后开关回到旧值", async () => {
    const el = await renderPage();
    sendMessage.mockImplementationOnce(async () => {
      throw new Error("storage 写入失败");
    });
    const first = el.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      first?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(el.textContent).toContain("保存失败");
    expect(el.querySelector<HTMLButtonElement>('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("连续两次保存失败后回到最后一次已保存的值", async () => {
    const el = await renderPage();
    const firstSave = deferredWithReject<unknown>();
    const secondSave = deferredWithReject<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      switches[0]?.click();
      switches[2]?.click();
      await Promise.resolve();
    });
    firstSave.reject(new Error("第一次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    secondSave.reject(new Error("第二次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const states = [...el.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      .slice(0, 3)
      .map((toggle) => toggle.getAttribute("aria-checked"));
    expect(states).toEqual(["true", "true", "true"]);
  });

  it("两次保存乱序返回时，最终界面保留第二次改动", async () => {
    const el = await renderPage();
    const firstSave = deferred<unknown>();
    const secondSave = deferred<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      switches[0]?.click();
      switches[2]?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    firstSave.resolve({ ok: true, value: { bilibili: { enabled: false } } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const lastCall = sendMessage.mock.calls[sendMessage.mock.calls.length - 1]?.[0] as {
      patch: Record<string, { enabled: boolean }>;
    };
    expect(lastCall.patch.youtube?.enabled).toBe(false);
    secondSave.resolve({ ok: true, value: { bilibili: { enabled: false }, youtube: { enabled: false } } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const states = [...el.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      .slice(0, 3)
      .map((toggle) => toggle.getAttribute("aria-checked"));
    expect(states).toEqual(["false", "false", "false"]);
  });

  it("较早保存成功、较晚保存失败时回到已落盘的值", async () => {
    const el = await renderPage();
    const firstSave = deferred<unknown>();
    const secondSave = deferredWithReject<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      switches[0]?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    firstSave.resolve({ ok: true, value: { bilibili: { enabled: false } } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await act(async () => {
      switches[2]?.click();
      await Promise.resolve();
    });
    secondSave.reject(new Error("第二次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    const states = [...el.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
      .slice(0, 3)
      .map((toggle) => toggle.getAttribute("aria-checked"));
    expect(states).toEqual(["false", "false", "true"]);
  });

  it("较早保存失败、较晚保存成功时清掉旧错误", async () => {
    const el = await renderPage();
    const firstSave = deferredWithReject<unknown>();
    const secondSave = deferred<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    await act(async () => {
      switches[0]?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const secondCall = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "settings.setSiteSwitches"
    )?.[0] as { patch: Record<string, unknown> };
    firstSave.reject(new Error("第一次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(el.textContent).toContain("第一次没保存");
    await act(async () => {
      switches[2]?.click();
      await Promise.resolve();
    });
    secondSave.resolve({ ok: true, value: secondCall.patch });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(el.textContent).not.toContain("保存失败");
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return deferredWithReject<T>();
}

function deferredWithReject<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
