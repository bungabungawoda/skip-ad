// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionErrorAlert, ConnectionForm, type ConnectionFormProps } from "../ConnectionViews";
import {
  chooseProvider,
  openProviderList
} from "../../../../tests/helpers/provider-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
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

function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function formProps(overrides: Partial<ConnectionFormProps> = {}): ConnectionFormProps {
  return {
    form: { providerId: "custom", apiKey: "", baseUrl: "", model: "" },
    busy: false,
    hasSaved: false,
    addressError: null,
    onChooseProvider: vi.fn(),
    onChange: vi.fn(),
    onCommitAddress: vi.fn(),
    onAction: vi.fn(),
    ...overrides
  };
}

describe("连接表单", () => {
  it("自定义端点不需要 Key，填完地址和模型就能点连接", async () => {
    const props = formProps();
    const el = await render(<ConnectionForm {...props} />);
    expect(el.querySelector("#base-url")).not.toBeNull();
    expect(el.querySelector("#model")).not.toBeNull();
    // custom 端点本地网关可能不需要 Key，连接按钮不因 Key 为空而禁用。
    expect(buttonByText(el, "连接").disabled).toBe(false);

    await act(async () => {
      typeInto(el.querySelector<HTMLInputElement>("#base-url"), "http://127.0.0.1:3425/v1");
      typeInto(el.querySelector<HTMLInputElement>("#model"), "qwen2.5:7b");
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    });
    expect(props.onChange).toHaveBeenCalledWith("baseUrl", "http://127.0.0.1:3425/v1");
    expect(props.onChange).toHaveBeenCalledWith("model", "qwen2.5:7b");

    await act(async () => {
      buttonByText(el, "连接").click();
      await Promise.resolve();
    });
    expect(props.onAction).toHaveBeenCalledWith("connect");
  });

  it("预设服务商没有 Key 时禁用连接，选择其他服务商时发出回调", async () => {
    const props = formProps({
      form: {
        providerId: "deepseek",
        apiKey: "",
        baseUrl: "https://api.deepseek.com",
        model: ""
      }
    });
    const el = await render(<ConnectionForm {...props} />);
    expect(el.querySelector<HTMLInputElement>("#base-url")?.value).toBe(
      "https://api.deepseek.com"
    );
    expect(el.querySelector("#model")).toBeNull();
    expect(buttonByText(el, "连接").disabled).toBe(true);
    await chooseProvider("custom");
    expect(props.onChooseProvider).toHaveBeenCalledWith("custom");
  });

  it("下拉只显示服务商名称，不显示国产、国外、自定义标签", async () => {
    const el = await render(<ConnectionForm {...formProps()} />);
    await openProviderList();
    const labels = [...document.querySelectorAll("[role=option]")].map(
      (option) => option.textContent?.trim()
    );
    expect(labels).toEqual([
      "DeepSeek",
      "Kimi",
      "智谱 GLM",
      "硅基流动",
      "OpenAI",
      "Claude",
      "OpenRouter",
      "自定义端点"
    ]);
    expect(el.textContent).not.toContain("国产");
    expect(el.textContent).not.toContain("国外");
  });

  it("地址失焦和回车都会提交识别结果", async () => {
    const props = formProps();
    const el = await render(<ConnectionForm {...props} />);
    const address = el.querySelector<HTMLInputElement>("#base-url");
    await act(async () => {
      typeInto(address, "https://api.openai.com/v1/chat/completions");
      address?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(props.onCommitAddress).toHaveBeenCalledTimes(1);

    await act(async () => {
      address?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await Promise.resolve();
    });
    expect(props.onCommitAddress).toHaveBeenCalledTimes(2);
  });

  it("地址错误显示在输入框下面", async () => {
    const el = await render(
      <ConnectionForm
        {...formProps({
          addressError: "地址要带 https://"
        })}
      />
    );
    expect(el.textContent).toContain("地址要带 https://");
    expect(el.querySelector("#base-url")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("已保存时显示取消，点击走 cancelSwitch", async () => {
    const props = formProps({ hasSaved: true });
    const el = await render(<ConnectionForm {...props} />);
    await act(async () => {
      buttonByText(el, "取消").click();
      await Promise.resolve();
    });
    expect(props.onAction).toHaveBeenCalledWith("cancelSwitch");
  });
});

describe("连接失败提示", () => {
  it("默认只给人话，技术细节折叠", async () => {
    const onToggle = vi.fn();
    const el = await render(
      <ConnectionErrorAlert
        error={{ message: "这个 Key 用不了", detail: "HTTP 401: invalid key" }}
        showDetail={false}
        onToggle={onToggle}
      />
    );
    expect(el.textContent).toContain("这个 Key 用不了");
    expect(el.textContent).not.toContain("HTTP 401");
    await act(async () => {
      buttonByText(el, "技术详情").click();
      await Promise.resolve();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("展开后显示技术细节", async () => {
    const el = await render(
      <ConnectionErrorAlert
        error={{ message: "这个 Key 用不了", detail: "HTTP 401: invalid key" }}
        showDetail={true}
        onToggle={vi.fn()}
      />
    );
    expect(el.textContent).toContain("HTTP 401: invalid key");
  });
});
