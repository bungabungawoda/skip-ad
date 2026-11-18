// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PolicyPage } from "../PolicyPage";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let area: ReturnType<typeof createMemoryStorageArea>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  area = createMemoryStorageArea();
  sendMessage = vi.fn(async (request: { type: string; patch?: unknown }) =>
    request.type === "settings.setPolicy"
      ? { ok: true, value: { ...DEFAULT_POLICY, ...(request.patch as object) } }
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
    root?.render(<PolicyPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PolicyPage", () => {
  it("按 kindOrder 渲染六种类型与策略选择", async () => {
    const el = await renderPage();
    for (const label of ["商单", "植入", "带货", "自我推广", "主题内容", "未知"]) {
      expect(el.textContent).toContain(label);
    }
    expect(el.querySelectorAll("input")).toHaveLength(6);
    expect(el.textContent).toContain("自动跳的共同条件");
  });

  it("读取失败时说明原因，不一直停在加载中", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error("storage down");
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
    expect(el.textContent).toContain("类型策略读取失败：storage down");
    expect(el.textContent).not.toContain("正在读取类型策略");
  });

  it("收到设置变化后重新读取，并显示落盘后的描述", async () => {
    const el = await renderPage();
    const listener = (
      chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as ((message: unknown) => void) | undefined;
    expect(listener).toBeDefined();

    await area.set({
      analysis: {
        ...DEFAULT_POLICY,
        kindPromptOverrides: { sponsor: "刷新后的描述" }
      }
    });
    await act(async () => {
      listener?.({ type: "settings.changed" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]')?.value).toBe(
      "刷新后的描述"
    );
  });

  it("改写类型描述后保存策略，并带上新的描述", async () => {
    const el = await renderPage();
    const input = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input!.focus();
      typeInto(input!, "口播带货才算商单");
      await Promise.resolve();
    });
    await act(async () => {
      input!.blur();
      await Promise.resolve();
    });
    const saved = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "settings.setPolicy"
    )?.[0] as { patch: { kindPromptOverrides?: Record<string, string> } };
    expect(saved.patch.kindPromptOverrides?.sponsor).toBe("口播带货才算商单");
  });

  it("两次改写按顺序写回后台，最终保留第二次描述", async () => {
    const el = await renderPage();
    const firstWrite = deferred<unknown>();
    const secondWrite = deferred<unknown>();
    sendMessage.mockImplementationOnce(async () => firstWrite.promise);
    sendMessage.mockImplementationOnce(async () => secondWrite.promise);
    const input = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      input!.focus();
      typeInto(input!, "第一次改写");
      await Promise.resolve();
    });
    await act(async () => {
      input!.blur();
      await Promise.resolve();
    });
    let calls = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "settings.setPolicy"
    );
    expect(calls).toHaveLength(1);
    const firstRequest = calls[0]?.[0] as {
      patch: { kindPromptOverrides?: Record<string, string> };
    };
    firstWrite.resolve({ ok: true, value: { ...DEFAULT_POLICY, ...firstRequest.patch } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const inputAgain = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      inputAgain!.focus();
      typeInto(inputAgain!, "第二次改写");
      await Promise.resolve();
    });
    await act(async () => {
      inputAgain!.blur();
      await Promise.resolve();
    });
    calls = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "settings.setPolicy"
    );
    expect(calls).toHaveLength(2);
    const last = calls[calls.length - 1]?.[0] as {
      patch: { kindPromptOverrides?: Record<string, string> };
    };
    expect(last.patch.kindPromptOverrides?.sponsor).toBe("第二次改写");
    secondWrite.resolve({ ok: true, value: { ...DEFAULT_POLICY, ...last.patch } });
    await act(async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
  });

  it("连续两次保存失败后回到最后一次已保存的描述", async () => {
    const el = await renderPage();
    const firstSave = deferredWithReject<unknown>();
    const secondSave = deferredWithReject<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const input = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      input!.focus();
      typeInto(input!, "第一次改写");
      input!.blur();
      await Promise.resolve();
    });
    const inputAgain = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      inputAgain!.focus();
      typeInto(inputAgain!, "第二次改写");
      inputAgain!.blur();
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
    expect(el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]')?.value).toBe("");
  });

  it("较早保存成功、较晚保存失败时回到已落盘的描述", async () => {
    const el = await renderPage();
    const firstSave = deferred<unknown>();
    const secondSave = deferredWithReject<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const input = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      input!.focus();
      typeInto(input!, "第一次改写");
      input!.blur();
      await Promise.resolve();
    });
    const firstRequest = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "settings.setPolicy"
    )?.[0] as { patch: Record<string, unknown> };
    firstSave.resolve({ ok: true, value: { ...DEFAULT_POLICY, ...firstRequest.patch } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const inputAgain = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      inputAgain!.focus();
      typeInto(inputAgain!, "第二次改写");
      inputAgain!.blur();
      await Promise.resolve();
    });
    secondSave.reject(new Error("第二次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]')?.value).toBe(
      "第一次改写"
    );
  });

  it("较早保存失败、较晚保存成功时清掉旧错误", async () => {
    const el = await renderPage();
    const firstSave = deferredWithReject<unknown>();
    const secondSave = deferred<unknown>();
    sendMessage.mockImplementationOnce(async () => firstSave.promise);
    sendMessage.mockImplementationOnce(async () => secondSave.promise);
    const input = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      input!.focus();
      typeInto(input!, "第一次改写");
      input!.blur();
      await Promise.resolve();
    });
    const calls = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "settings.setPolicy"
    );
    const lastRequest = calls.at(-1)?.[0] as { patch: Record<string, unknown> };
    firstSave.reject(new Error("第一次没保存"));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(el.textContent).toContain("第一次没保存");
    const inputAgain = el.querySelector<HTMLInputElement>('input[aria-label^="自定义"]');
    await act(async () => {
      inputAgain!.focus();
      typeInto(inputAgain!, "第二次改写");
      inputAgain!.blur();
      await Promise.resolve();
    });
    secondSave.resolve({ ok: true, value: { ...DEFAULT_POLICY, ...lastRequest.patch } });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(el.textContent).not.toContain("第一次没保存");
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
