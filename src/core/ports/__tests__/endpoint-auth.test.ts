import { describe, expect, it, vi } from "vitest";
import { endpointPattern, requestEndpointAuthorization } from "../endpoint-auth";

describe("端点授权", () => {
  it("权限模式丢掉端口，只保留协议与主机名", () => {
    expect(endpointPattern("http://127.0.0.1:3425/v1")).toBe("http://127.0.0.1/*");
    expect(endpointPattern("https://gateway.example.com:8443/v1")).toBe(
      "https://gateway.example.com/*"
    );
    expect(endpointPattern("not a url")).toBeNull();
  });

  it("拒绝时不记录模式，第二次连接会重新申请", async () => {
    const request = vi.fn(async () => false);
    const first = await requestEndpointAuthorization({
      url: "https://api.example.com",
      authorizedPattern: null,
      request
    });
    expect(first).toEqual({ authorized: false, authorizedPattern: null });
    const second = await requestEndpointAuthorization({
      url: "https://api.example.com",
      authorizedPattern: first.authorizedPattern,
      request
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(second.authorizedPattern).toBeNull();
  });

  it("授权成功后同一主机不重复弹窗", async () => {
    const request = vi.fn(async () => true);
    const first = await requestEndpointAuthorization({
      url: "http://127.0.0.1:3425/v1",
      authorizedPattern: null,
      request
    });
    const second = await requestEndpointAuthorization({
      url: "http://127.0.0.1:3425/v1",
      authorizedPattern: first.authorizedPattern,
      request
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("http://127.0.0.1/*");
    expect(second).toEqual({ authorized: true, authorizedPattern: "http://127.0.0.1/*" });
  });

  it("地址无效时不申请授权；授权 API 抛错按拒绝处理", async () => {
    const request = vi.fn(async () => true);
    await expect(
      requestEndpointAuthorization({ url: null, authorizedPattern: null, request })
    ).resolves.toEqual({ authorized: true, authorizedPattern: null });
    expect(request).not.toHaveBeenCalled();
    const failing = vi.fn(async () => {
      throw new Error("no gesture");
    });
    await expect(
      requestEndpointAuthorization({
        url: "https://x.dev",
        authorizedPattern: null,
        request: failing
      })
    ).resolves.toEqual({ authorized: false, authorizedPattern: null });
  });
});
