// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DecisionSection } from "../DecisionSection";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { DEFAULT_DECISION_MODEL } from "../../../core/ports/decision/config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let area: ReturnType<typeof createMemoryStorageArea>;
let sendMessage: ReturnType<typeof vi.fn>;
let permissionRequest: ReturnType<typeof vi.fn>;
let decisionConfig: { endpoint: string; apiKey: string; model: string };
let llmConfigured: boolean;
let settingsListeners: Array<(message: unknown) => void>;

beforeEach(() => {
  area = createMemoryStorageArea();
  decisionConfig = { endpoint: "", apiKey: "", model: DEFAULT_DECISION_MODEL };
  llmConfigured = true;
  settingsListeners = [];
  permissionRequest = vi.fn(async () => true);
  sendMessage = vi.fn(async (request: { type: string; patch?: Partial<typeof decisionConfig> }) => {
    if (request.type === "settings.getDecisionConfig") {
      return { ok: true, value: decisionConfig };
    }
    if (request.type === "settings.setDecisionConfig") {
      decisionConfig = { ...decisionConfig, ...request.patch };
      return { ok: true, value: decisionConfig };
    }
    if (request.type === "settings.get") {
      return {
        ok: true,
        value: {
          policy: {},
          llmConfigured,
          decisionConfigured: decisionConfig.endpoint.length > 0,
          analysisConfigured: true,
          siteSwitches: {}
        }
      };
    }
    return { ok: true, value: null };
  });
  Object.defineProperty(globalThis, "chrome", {
    value: {
      storage: { local: { get: area.get, set: area.set, remove: area.remove } },
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (listener: (message: unknown) => void): void => {
            settingsListeners.push(listener);
          },
          removeListener: (listener: (message: unknown) => void): void => {
            settingsListeners = settingsListeners.filter((item) => item !== listener);
          }
        }
      },
      permissions: { request: permissionRequest }
    },
    configurable: true,
    writable: true
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

async function renderSection(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DecisionSection />);
  });
  await flush();
  return container;
}

function typeInto(input: HTMLInputElement | null, value: string): void {
  expect(input).not.toBeNull();
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const button = [...el.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text)
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("决策模型设置", () => {
  it("地址留空时说明使用 LLM", async () => {
    const view = await renderSection();
    expect(view.textContent).toContain("只使用上面配置的模型");
    expect(view.textContent).toContain("地址留空就用上面配置的模型");
  });

  it("收到设置变化后刷新 LLM 连接状态", async () => {
    const view = await renderSection();
    const readsBefore = sendMessage.mock.calls.filter(([request]) => request.type === "settings.get").length;
    llmConfigured = false;
    await act(async () => {
      settingsListeners.forEach((listener) => listener({ type: "settings.changed" }));
      await flush();
    });
    const readsAfter = sendMessage.mock.calls.filter(([request]) => request.type === "settings.get").length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
    expect(view).toBeDefined();
  });

  it("保存完整接口地址，并在点击手势里申请主机权限", async () => {
    const view = await renderSection();
    await act(async () => {
      typeInto(
        view.querySelector<HTMLInputElement>("#decision-endpoint"),
        "https://gateway.example.com/v1/decisions"
      );
      await flush();
    });
    await act(async () => {
      buttonByText(view, "保存决策模型设置").click();
      await flush();
    });

    expect(permissionRequest).toHaveBeenCalledWith({
      origins: ["https://gateway.example.com/*"]
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "settings.setDecisionConfig",
      patch: {
        endpoint: "https://gateway.example.com/v1/decisions",
        apiKey: "",
        model: DEFAULT_DECISION_MODEL
      }
    });
    expect(view.textContent).toContain("决策模型优先");
    expect(view.textContent).toContain("已保存");
  });

  it("地址不合法时给出原因，不发保存请求", async () => {
    const view = await renderSection();
    await act(async () => {
      typeInto(view.querySelector<HTMLInputElement>("#decision-endpoint"), "not a url");
      await flush();
    });
    await act(async () => {
      buttonByText(view, "保存决策模型设置").click();
      await flush();
    });

    expect(view.textContent).toContain("接口地址要填完整 URL");
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "settings.setDecisionConfig" })
    );
  });

  it("清空地址后不再申请权限，只保存空地址", async () => {
    decisionConfig = {
      endpoint: "https://gateway.example.com/v1/decisions",
      apiKey: "key",
      model: DEFAULT_DECISION_MODEL
    };
    const view = await renderSection();
    await act(async () => {
      typeInto(view.querySelector<HTMLInputElement>("#decision-endpoint"), "");
      await flush();
    });
    await act(async () => {
      buttonByText(view, "保存决策模型设置").click();
      await flush();
    });

    expect(permissionRequest).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "settings.setDecisionConfig",
      patch: { endpoint: "", apiKey: "key", model: DEFAULT_DECISION_MODEL }
    });
    expect(view.textContent).toContain("只使用上面配置的模型");
  });

  it("读取失败时显示原因，不一直停在加载态", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.getDecisionConfig") throw new Error("storage 读失败");
      return { ok: true, value: null };
    });
    const view = await renderSection();
    expect(view.textContent).toContain("决策模型设置读取失败");
    expect(view.querySelector<HTMLButtonElement>("#decision-endpoint")?.disabled).toBe(false);
  });
});
