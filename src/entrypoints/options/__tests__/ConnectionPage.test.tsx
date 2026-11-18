// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionPage } from "../ConnectionPage";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import {
  chooseProvider,
  openProviderList
} from "../../../../tests/helpers/provider-select";
import { chromeStorageArea } from "../../../core/ports/chrome-storage";
import { saveConnection } from "../../../core/ports/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let area: ReturnType<typeof createMemoryStorageArea>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  area = createMemoryStorageArea();
  sendMessage = vi.fn(async (request: { type: string }) => {
    if (request.type === "settings.get") {
      return {
        ok: true,
        value: {
          policy: {},
          llmConfigured: false,
          decisionConfigured: false,
          analysisConfigured: false,
          siteSwitches: {}
        }
      };
    }
    if (request.type === "settings.getDecisionConfig") {
      return {
        ok: true,
        value: { endpoint: "", apiKey: "", model: "gemini-decision-1" }
      };
    }
    if (request.type === "connection.connect") {
      return {
        ok: true,
        value: {
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          model: "deepseek-chat",
          notes: []
        }
      };
    }
    return { ok: true, value: null };
  });
  vi.stubGlobal("chrome", {
    storage: { local: { get: area.get, set: area.set, remove: area.remove } },
    runtime: { sendMessage, openOptionsPage: vi.fn() },
    permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) }
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

async function renderPage(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ConnectionPage />);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return container;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const button = [...el.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text
  );
  if (!button) throw new Error(`button ${text} not found`);
  return button as HTMLButtonElement;
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** React 自己追踪输入框的值：直接改 .value 不会触发 onChange，必须走原生 setter。 */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function commitAddress(input: HTMLInputElement | null): Promise<void> {
  if (!input) return;
  await act(async () => {
    input.focus();
    input.blur();
    await settle(3);
  });
}

describe("ConnectionPage", () => {
  it("默认填入 DeepSeek 和默认地址，Key 为空", async () => {
    const el = await renderPage();
    expect(el.querySelector<HTMLButtonElement>("#provider")?.textContent).toContain(
      "DeepSeek"
    );
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://api.deepseek.com"
    );
    expect(el.querySelector<HTMLInputElement>("#apikey")?.value).toBe("");
  });

  it("下拉列表顺序不变，且不显示国产、国外、自定义标签", async () => {
    const el = await renderPage();
    await openProviderList(el);
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    const ids = options.map((option) => option.dataset.providerId);
    expect(ids).toEqual([
      "deepseek",
      "moonshot",
      "zhipu",
      "siliconflow",
      "openai",
      "anthropic",
      "openrouter",
      "custom"
    ]);
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "DeepSeek",
      "Kimi",
      "智谱 GLM",
      "硅基流动",
      "OpenAI",
      "Claude",
      "OpenRouter",
      "自定义端点"
    ]);
  });

  it("选择服务商后自动填这家默认地址", async () => {
    const el = await renderPage();
    await chooseProvider("openai", el);
    expect(el.querySelector<HTMLButtonElement>("#provider")?.textContent).toContain(
      "OpenAI"
    );
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://api.openai.com/v1"
    );
    expect(el.querySelector("#model")).toBeNull();
  });

  it("粘贴已知地址后自动选服务商，失焦后地址归一", async () => {
    const el = await renderPage();
    const address = el.querySelector<HTMLInputElement>("#base-url");
    await act(async () => {
      typeInto(address, "https://api.openai.com/v1/chat/completions");
      await settle(2);
    });
    expect(el.querySelector<HTMLButtonElement>("#provider")?.textContent).toContain(
      "OpenAI"
    );
    expect(address?.value).toBe("https://api.openai.com/v1/chat/completions");

    await commitAddress(address);
    expect(address?.value).toBe("https://api.openai.com/v1");
    expect(el.querySelector("#model")).toBeNull();
  });

  it("粘贴未知地址后切自定义端点，保留地址并显示模型名", async () => {
    const el = await renderPage();
    const address = el.querySelector<HTMLInputElement>("#base-url");
    await act(async () => {
      typeInto(address, "https://gateway.example.com/v1");
      await settle(2);
    });
    expect(el.querySelector<HTMLButtonElement>("#provider")?.textContent).toContain(
      "自定义端点"
    );
    expect(address?.value).toBe("https://gateway.example.com/v1");
    expect(el.querySelector("#model")).not.toBeNull();
  });

  it("粘贴已知地址后连接，按识别出的服务商发送请求", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return { ok: true, value: { policy: {}, llmConfigured: false, siteSwitches: {} } };
      }
      if (request.type === "settings.getDecisionConfig") {
        return {
          ok: true,
          value: { endpoint: "", apiKey: "", model: "gemini-decision-1" }
        };
      }
      if (request.type === "connection.connect") {
        return {
          ok: true,
          value: {
            providerId: "openai",
            providerLabel: "OpenAI",
            model: "gpt-4o-mini",
            notes: []
          }
        };
      }
      return { ok: true, value: null };
    });
    const el = await renderPage();
    await act(async () => {
      typeInto(
        el.querySelector<HTMLInputElement>("#base-url"),
        "https://api.openai.com/v1/chat/completions"
      );
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-test");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });

    const sent = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "connection.connect"
    )?.[0] as { input: Record<string, unknown> };
    expect(sent.input).toEqual({ providerId: "openai", apiKey: "sk-test" });
    expect(el.textContent).toContain("已连接 OpenAI · gpt-4o-mini");
  });

  it("地址换到另一台主机时清空旧 Key", async () => {
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-test");
      await settle(2);
    });
    await act(async () => {
      typeInto(
        el.querySelector<HTMLInputElement>("#base-url"),
        "https://gateway.example.com/v1"
      );
      await settle(2);
    });
    expect(el.querySelector<HTMLInputElement>("#apikey")?.value).toBe("");
  });

  it("无效地址不发连接请求，就在地址下面提示", async () => {
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#base-url"), "ftp://example.com/v1");
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-test");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });
    expect(el.textContent).toContain("地址要带 https://");
    expect(
      sendMessage.mock.calls.some(
        (call) => (call[0] as { type: string }).type === "connection.connect"
      )
    ).toBe(false);
  });

  it("切回自定义端点时恢复上次填的地址", async () => {
    const el = await renderPage();
    await act(async () => {
      typeInto(
        el.querySelector<HTMLInputElement>("#base-url"),
        "https://gateway.example.com/v1"
      );
      await settle(2);
    });
    await chooseProvider("deepseek", el);
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://api.deepseek.com"
    );
    await chooseProvider("custom", el);
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://gateway.example.com/v1"
    );
  });

  it("选自定义端点后才出现模型输入框，地址框始终存在", async () => {
    const el = await renderPage();
    expect(el.querySelector("#base-url")).not.toBeNull();
    expect(el.querySelector("#model")).toBeNull();

    await chooseProvider("custom", el);

    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe("");
    expect(el.querySelector<HTMLInputElement>("#model")).not.toBeNull();
  });

  it("connects with one click and shows the result line", async () => {
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-test");
      await settle(2);
    });

    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });

    const sent = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "connection.connect"
    )?.[0] as { input: { providerId: string; apiKey: string } };
    expect(sent.input).toMatchObject({ providerId: "deepseek", apiKey: "sk-test" });
    expect(el.textContent).toContain("已连接 DeepSeek · deepseek-chat");
    expect(el.querySelector<HTMLInputElement>("#apikey")).toBeNull();
  });

  it("shows one sentence on failure and keeps the details collapsed", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return { ok: true, value: { policy: {}, llmConfigured: false, siteSwitches: {} } };
      }
      return { ok: false, error: { kind: "auth", message: "HTTP 401: invalid key" } };
    });
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-bad");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });

    expect(el.textContent).toContain("这个 Key 用不了");
    expect(el.textContent).not.toContain("HTTP 401");
  });

  it("已连接时显示结果卡片，换一家、取消、断开都能回到表单", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return {
          ok: true,
          value: {
            policy: {},
            llmConfigured: true,
            siteSwitches: {},
            providerId: "deepseek",
            providerLabel: "DeepSeek",
            model: "deepseek-chat"
          }
        };
      }
      return { ok: true, value: null };
    });
    const el = await renderPage();
    expect(el.textContent).toContain("已连接 DeepSeek · deepseek-chat");
    expect(el.textContent).toContain("https://api.deepseek.com");

    await act(async () => {
      buttonByText(el, "换一家").click();
      await settle(2);
    });
    expect(el.querySelector("#apikey")).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://api.deepseek.com"
    );

    await act(async () => {
      buttonByText(el, "取消").click();
      await settle(2);
    });
    expect(el.textContent).toContain("已连接 DeepSeek");

    await act(async () => {
      buttonByText(el, "断开连接").click();
      await settle();
    });
    expect(
      sendMessage.mock.calls.some(
        (call) => (call[0] as { type: string }).type === "connection.disconnect"
      )
    ).toBe(true);
    expect(el.querySelector("#apikey")).not.toBeNull();
  });

  it("自定义端点连接先申请权限，地址与模型一起发给后台", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      storage: { local: { get: area.get, set: area.set, remove: area.remove } },
      runtime: { sendMessage, openOptionsPage: vi.fn() },
      permissions: { request, contains: vi.fn(async () => true) }
    });
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#base-url"), "http://127.0.0.1:3425/v1");
      await settle(2);
    });
    expect(el.querySelector<HTMLButtonElement>("#provider")?.textContent).toContain(
      "自定义端点"
    );
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#model"), "qwen2.5:7b");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });
    expect(request).toHaveBeenCalledWith({ origins: ["http://127.0.0.1/*"] });
    const sent = sendMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "connection.connect"
    )?.[0] as { input: { providerId: string; baseUrl: string; model: string } };
    expect(sent.input).toMatchObject({
      providerId: "custom",
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "qwen2.5:7b"
    });
  });

  it("读回已保存的自定义端点，不要求用户重填地址和模型", async () => {
    await saveConnection(chromeStorageArea(), "custom", {
      model: "qwen2.5:7b",
      apiKey: "",
      jsonObject: false,
      connectedAt: 1,
      baseUrl: "http://127.0.0.1:3425/v1",
      protocol: "openai-chat"
    });
    const el = await renderPage();
    await chooseProvider("custom", el);
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "http://127.0.0.1:3425/v1"
    );
    expect(el.querySelector<HTMLInputElement>("#model")?.value).toBe("qwen2.5:7b");
  });

  it("点开技术详情才显示原始错误，收起后隐藏", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return { ok: true, value: { policy: {}, llmConfigured: false, siteSwitches: {} } };
      }
      return { ok: false, error: { kind: "auth", message: "HTTP 401: invalid key" } };
    });
    const el = await renderPage();
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#apikey"), "sk-bad");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });
    await act(async () => {
      buttonByText(el, "技术详情").click();
      await settle(2);
    });
    expect(el.textContent).toContain("HTTP 401: invalid key");
    await act(async () => {
      buttonByText(el, "技术详情").click();
      await settle(2);
    });
    expect(el.textContent).not.toContain("HTTP 401: invalid key");
  });

  it("读本机配置失败仍显示页面，只记一行日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys: unknown) => {
            // 只让连接配置那次读取失败，决策模型设置的读取照常返回。
            if (keys === "llm") throw new Error("storage 坏了");
            return area.get(keys as string);
          },
          set: area.set,
          remove: area.remove
        }
      },
      runtime: { sendMessage, openOptionsPage: vi.fn() },
      permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) }
    });
    const el = await renderPage();
    expect(el.querySelector("#apikey")).not.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("读取连接状态失败");
  });

  it("端点未授权时只记权限模式，不把完整地址写进日志，并继续直连", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      storage: { local: { get: area.get, set: area.set, remove: area.remove } },
      runtime: { sendMessage, openOptionsPage: vi.fn() },
      permissions: { request: vi.fn(async () => false), contains: vi.fn(async () => true) }
    });
    const el = await renderPage();
    await chooseProvider("custom", el);
    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#base-url"), "https://gateway.example.com/v1?key=secret");
      await settle(2);
    });
    await act(async () => {
      buttonByText(el, "连接").click();
      await settle();
    });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("https://gateway.example.com/*");
    expect(logged).not.toContain("key=secret");
    expect(
      sendMessage.mock.calls.some(
        (call) => (call[0] as { type: string }).type === "connection.connect"
      )
    ).toBe(true);
  });

  it("断开连接失败时把原因显示在页面上", async () => {
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return {
          ok: true,
          value: {
            policy: {},
            llmConfigured: true,
            siteSwitches: {},
            providerId: "deepseek",
            providerLabel: "DeepSeek",
            model: "deepseek-chat"
          }
        };
      }
      return { ok: false, error: { kind: "network", message: "后台没响应" } };
    });
    const el = await renderPage();
    await act(async () => {
      buttonByText(el, "断开连接").click();
      await settle();
    });
    expect(el.textContent).toContain("连不上这家的服务");
  });

  it("清缓存失败只记日志，不弹错误卡片", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendMessage.mockImplementation(async (request: { type: string }) => {
      if (request.type === "settings.get") {
        return { ok: true, value: { policy: {}, llmConfigured: false, siteSwitches: {} } };
      }
      return { ok: false, error: { kind: "network", message: "后台没响应" } };
    });
    const el = await renderPage();
    await act(async () => {
      buttonByText(el, "清除分析缓存").click();
      await settle(2);
    });
    expect(warn.mock.calls.flat().join(" ")).toContain("清空缓存失败");
    expect(el.textContent).toContain("清除缓存失败，请重试");
    expect(el.textContent).not.toContain("连不上这家的服务");
  });

  it("clears the analysis cache through the background", async () => {
    const el = await renderPage();
    await act(async () => {
      buttonByText(el, "清除分析缓存").click();
      await settle(2);
    });
    expect(
      sendMessage.mock.calls.some((call) => (call[0] as { type: string }).type === "cache.clear")
    ).toBe(true);
    expect(el.textContent).toContain("分析缓存已清除");
  });
});
