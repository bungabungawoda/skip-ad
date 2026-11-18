import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendUiRequest } from "../messages";

const tabQuery = vi.fn();
const tabSendMessage = vi.fn();

beforeEach(() => {
  vi.stubGlobal("chrome", {
    tabs: { query: tabQuery, sendMessage: tabSendMessage }
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendUiRequest", () => {
  it("其它网站（地址读不到）不打日志也不发消息", async () => {
    tabQuery.mockResolvedValue([{ id: 1 }]);

    const response = await sendUiRequest({ type: "ui.getState" });

    if (response.ok) throw new Error("不支持的页面应该失败");
    expect(response.error.kind).toBe("unsupported_page");
    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("地址不是 www.bilibili.com 时同样忽略", async () => {
    tabQuery.mockResolvedValue([{ id: 1, url: "https://example.com/watch" }]);

    const response = await sendUiRequest({ type: "ui.getState" });

    expect(response).toMatchObject({
      ok: false,
      error: { kind: "unsupported_page", message: expect.stringContaining("不是支持的视频页") }
    });
    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("B 站首页和搜索页不是视频页，忽略", async () => {
    tabQuery.mockResolvedValue([{ id: 1, url: "https://www.bilibili.com/" }]);

    const response = await sendUiRequest({ type: "ui.getState" });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.kind).toBe("unsupported_page");
    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("B 站视频页发送失败时保留警告", async () => {
    tabQuery.mockResolvedValue([
      { id: 7, url: "https://www.bilibili.com/video/BV1test/" }
    ]);
    tabSendMessage.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );

    const response = await sendUiRequest({ type: "ui.getState" });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.kind).toBe("no_content_script");
      expect(response.error.message).toContain("刷新");
    }
    expect(tabSendMessage).toHaveBeenCalledWith(7, { type: "ui.getState" });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("YouTube watch 页也视为支持的视频页", async () => {
    tabQuery.mockResolvedValue([
      { id: 7, url: "https://www.youtube.com/watch?v=abc" }
    ]);
    tabSendMessage.mockResolvedValue({ ok: true, value: null });

    const response = await sendUiRequest({ type: "ui.getState" });

    expect(response.ok).toBe(true);
    expect(tabSendMessage).toHaveBeenCalledWith(7, { type: "ui.getState" });
  });

  it("列表播放页正常返回结果且不打日志", async () => {
    tabQuery.mockResolvedValue([
      { id: 7, url: "https://www.bilibili.com/list/ml?bvid=BV1test" }
    ]);
    tabSendMessage.mockResolvedValue({ ok: true, value: null });

    const response = await sendUiRequest({ type: "ui.getState" });

    expect(response.ok).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
