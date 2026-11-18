// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePlayerDataRequest, installPlayerBridge } from "../player-bridge-main";
import { requestPlayerData } from "../player-bridge";
import { PLAYER_BRIDGE_CHANNEL, type PlayerDataRequest } from "../player-bridge-protocol";

const signal = new AbortController().signal;

function request(videoId = "abc"): PlayerDataRequest {
  return {
    channel: PLAYER_BRIDGE_CHANNEL,
    kind: "request",
    requestId: "req-1",
    videoId
  };
}

function response(
  videoId: string,
  options: { tracks?: unknown; lengthSeconds?: number } = {}
): Record<string, unknown> {
  return {
    videoDetails: { videoId, lengthSeconds: options.lengthSeconds ?? 600 },
    captions:
      options.tracks === undefined
        ? {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh",
                  languageCode: "zh",
                  name: { simpleText: "中文" }
                }
              ]
            }
          }
        : { playerCaptionsTracklistRenderer: { captionTracks: options.tracks } }
  };
}

function mountApp(value: unknown): void {
  const app = document.createElement("ytd-app") as HTMLElement & {
    data?: { playerResponse?: unknown };
  };
  app.data = { playerResponse: value };
  document.body.append(app);
}

/** 挂一个带 getPlayerResponse 的播放器容器。 */
function mountPlayer(value: unknown): void {
  const player = document.createElement("div");
  player.id = "movie_player";
  (player as HTMLElement & { getPlayerResponse?: () => unknown }).getPlayerResponse = () =>
    value;
  document.body.append(player);
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
});

describe("handlePlayerDataRequest", () => {
  it("ytd-app 是当前视频：返回轨道与时长", () => {
    mountApp(response("abc"));
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({
      status: "ok",
      videoId: "abc",
      source: "app",
      lengthSeconds: 600
    });
    if (result?.status !== "ok") throw new Error("expected ok");
    expect(result.tracks).toEqual([
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=zh",
        languageCode: "zh",
        name: "中文"
      }
    ]);
  });

  it("ytd-app 还是上一条视频，但播放器已经切到当前视频：用播放器来源", () => {
    mountApp(response("stale"));
    mountPlayer(response("abc"));
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({ status: "ok", videoId: "abc", source: "player" });
  });

  it("所有来源都不是当前视频：返回 not-ready，并带上实际 videoId", () => {
    mountApp(response("stale"));
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({ status: "not-ready", videoId: "stale" });
  });

  it("页面里没有播放器响应：返回 unavailable", () => {
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("当前视频明确没有 captionTracks：返回 ok 空轨道", () => {
    mountApp({
      videoDetails: { videoId: "abc", lengthSeconds: 600 }
    });
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({ status: "ok", tracks: [] });
  });

  it("当前视频有轨道但结构全坏：返回不可用，不冒充没有字幕", () => {
    mountApp(response("abc", { tracks: [{ baseUrl: "", languageCode: "" }] }));
    const result = handlePlayerDataRequest(request("abc"), document);
    expect(result).toMatchObject({
      status: "unavailable",
      detail: "播放器返回的字幕轨结构不完整"
    });
  });

  it("不是本协议的请求时返回 null", () => {
    expect(handlePlayerDataRequest({ kind: "request" }, document)).toBeNull();
  });
});

describe("requestPlayerData", () => {
  it("收到匹配 requestId 的回包时解析为 ok", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        {
          channel: PLAYER_BRIDGE_CHANNEL,
          kind: "response",
          requestId: data.requestId,
          status: "ok",
          videoId: data.videoId,
          source: "app",
          lengthSeconds: 600,
          tracks: []
        },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toMatchObject({ status: "ok", videoId: "abc", source: "app" });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("postMessage 抛错：unavailable 带原因", async () => {
    const broken = {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { origin: "https://www.youtube.com" },
      postMessage: () => {
        throw new Error("post blocked");
      }
    } as unknown as Window;
    const result = await requestPlayerData("abc", signal, { win: broken });
    expect(result).toMatchObject({ status: "unavailable", detail: "post blocked" });
  });

  it("postMessage 抛错后不留下等待中的定时器", async () => {
    vi.useFakeTimers();
    try {
      const broken = {
        addEventListener: () => {},
        removeEventListener: () => {},
        location: { origin: "https://www.youtube.com" },
        postMessage: () => {
          throw new Error("post blocked");
        }
      } as unknown as Window;
      await requestPlayerData("abc", signal, { win: broken });
      // 旧实现直接 return，800ms 的等待定时器会一直挂着。
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("origin 不匹配的回包被忽略，等到超时", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.example",
          data: {
            channel: PLAYER_BRIDGE_CHANNEL,
            kind: "response",
            requestId: data.requestId,
            status: "ok",
            videoId: "abc",
            source: "app",
            tracks: []
          }
        })
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 60 });
      expect(result).toMatchObject({ status: "unavailable", detail: expect.stringContaining("没有响应") });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("回包缺 lengthSeconds：字段省略", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        {
          channel: PLAYER_BRIDGE_CHANNEL,
          kind: "response",
          requestId: data.requestId,
          status: "ok",
          videoId: "abc",
          source: "player",
          tracks: []
        },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toMatchObject({ status: "ok", videoId: "abc", source: "player", tracks: [] });
      expect(result).not.toHaveProperty("lengthSeconds");
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("ok 回包轨道结构全坏：unavailable，不冒充没有字幕", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        {
          channel: PLAYER_BRIDGE_CHANNEL,
          kind: "response",
          requestId: data.requestId,
          status: "ok",
          videoId: "abc",
          source: "app",
          tracks: [{ baseUrl: "", languageCode: "" }]
        },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toMatchObject({
        status: "unavailable",
        detail: "播放器桥返回的字幕轨结构不完整"
      });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("not-ready 回包缺 videoId：字段省略", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        { channel: PLAYER_BRIDGE_CHANNEL, kind: "response", requestId: data.requestId, status: "not-ready" },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toEqual({ status: "not-ready" });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("unavailable 回包缺 detail：用默认文案", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        { channel: PLAYER_BRIDGE_CHANNEL, kind: "response", requestId: data.requestId, status: "unavailable" },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toMatchObject({ status: "unavailable", detail: "播放器桥不可用" });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("not-ready 回包带 videoId：原样透传", async () => {
    const listener = (event: MessageEvent): void => {
      const data = event.data as PlayerDataRequest;
      if (data?.kind !== "request") return;
      window.postMessage(
        {
          channel: PLAYER_BRIDGE_CHANNEL,
          kind: "response",
          requestId: data.requestId,
          status: "not-ready",
          videoId: "stale"
        },
        window.location.origin
      );
    };
    window.addEventListener("message", listener);
    try {
      const result = await requestPlayerData("abc", signal, { timeoutMs: 100 });
      expect(result).toEqual({ status: "not-ready", videoId: "stale" });
    } finally {
      window.removeEventListener("message", listener);
    }
  });

  it("没有桥回包时超时为 unavailable", async () => {
    const result = await requestPlayerData("abc", signal, { timeoutMs: 10 });
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("已取消时立即拒绝，不等待超时", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestPlayerData("abc", controller.signal, { timeoutMs: 1_000 })
    ).rejects.toThrow("Aborted");
  });
});

describe("installPlayerBridge", () => {
  it("数据请求也走同一监听器：回 player data 响应", async () => {
    const remove = installPlayerBridge(window);
    const responses: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      if ((event.data as { kind?: string } | null)?.kind === "response") responses.push(event.data);
    };
    window.addEventListener("message", listener);
    try {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: { channel: PLAYER_BRIDGE_CHANNEL, kind: "request", requestId: "d1", videoId: "abc" }
        })
      );
      await vi.waitFor(() => expect(responses.length).toBe(1), { timeout: 2_000 });
      expect(responses[0]).toMatchObject({ kind: "response", status: "unavailable" });
    } finally {
      window.removeEventListener("message", listener);
      remove();
    }
  });
});
