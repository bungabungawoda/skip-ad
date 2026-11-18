import { describe, expect, it } from "vitest";
import { mergeSiteManifests, type WxtManifest } from "../src/wxt/manifest-sites";
import { parseSiteManifest } from "../src/core/plugin/manifest";
import type { SiteManifest } from "../src/core/plugin/types";

function site(overrides: Partial<SiteManifest> = {}): SiteManifest {
  return {
    id: "bilibili",
    contentMatches: ["https://www.bilibili.com/video/*"],
    excludeMatches: [],
    hostPermissions: ["https://www.bilibili.com/*"],
    capabilities: [],
    ...overrides
  };
}

function base(overrides: Partial<WxtManifest> = {}): WxtManifest {
  return {
    permissions: ["storage"],
    host_permissions: ["https://www.bilibili.com/*"],
    content_scripts: [
      {
        matches: ["https://www.bilibili.com/video/*"],
        run_at: "document_idle",
        js: ["content-scripts/content.js"]
      }
    ],
    ...overrides
  };
}

describe("mergeSiteManifests", () => {
  it("单站：matches 与 host_permissions 来自站点声明，替换 wxt 默认值", () => {
    // base 给的是与站点声明不同的通用值：透传实现会在这里失败。
    const merged = mergeSiteManifests(
      [site()],
      base({
        host_permissions: [],
        content_scripts: [
          {
            matches: ["<all_urls>"],
            run_at: "document_idle",
            js: ["content-scripts/content.js"]
          }
        ]
      })
    );
    expect(merged.host_permissions).toEqual(["https://www.bilibili.com/*"]);
    expect(merged.content_scripts?.[0]?.matches).toEqual(["https://www.bilibili.com/video/*"]);
    expect(merged.permissions).toEqual(["storage"]);
    expect(merged.content_scripts?.[0]?.run_at).toBe("document_idle");
    expect(merged.content_scripts?.[0]?.js).toEqual(["content-scripts/content.js"]);
  });

  it("双站：host_permissions 去重合并，contentMatches 并集按站顺序拼接", () => {
    const merged = mergeSiteManifests(
      [
        site(),
        site({
          id: "youtube",
          contentMatches: ["https://www.youtube.com/watch*"],
          hostPermissions: [
            "https://www.youtube.com/*",
            "https://www.bilibili.com/*"
          ]
        })
      ],
      base()
    );
    expect(merged.host_permissions).toEqual([
      "https://www.bilibili.com/*",
      "https://www.youtube.com/*"
    ]);
    expect(merged.content_scripts?.[0]?.matches).toEqual([
      "https://www.bilibili.com/video/*",
      "https://www.youtube.com/watch*"
    ]);
  });

  it("excludeMatches 并集非空时写入 exclude_matches", () => {
    const merged = mergeSiteManifests(
      [site({ excludeMatches: ["https://www.bilibili.com/list/*"] })],
      base()
    );
    expect(merged.content_scripts?.[0]?.exclude_matches).toEqual([
      "https://www.bilibili.com/list/*"
    ]);
  });

  it("MAIN 世界脚本保留自己的 matches，不被各站并集覆盖", () => {
    const merged = mergeSiteManifests(
      [
        site({ excludeMatches: ["https://www.bilibili.com/list/*"] }),
        site({
          id: "youtube",
          contentMatches: ["https://www.youtube.com/watch*"],
          hostPermissions: ["https://www.youtube.com/*"]
        })
      ],
      base({
        content_scripts: [
          {
            matches: ["https://www.youtube.com/watch*"],
            world: "MAIN",
            run_at: "document_idle",
            js: ["content-scripts/youtube-main.js"]
          },
          {
            matches: ["https://www.bilibili.com/video/*"],
            run_at: "document_idle",
            js: ["content-scripts/content.js"]
          }
        ]
      })
    );

    // 站点专用的 MAIN 世界桥不能被注入到 B 站，也不能被共享并集改写。
    expect(merged.content_scripts?.[0]?.matches).toEqual([
      "https://www.youtube.com/watch*"
    ]);
    expect(merged.content_scripts?.[0]?.world).toBe("MAIN");
    expect(merged.content_scripts?.[0]?.exclude_matches).toBeUndefined();
    // 隔离世界的共享脚本仍然接收各站并集与 exclude_matches。
    expect(merged.content_scripts?.[1]?.matches).toEqual([
      "https://www.bilibili.com/video/*",
      "https://www.youtube.com/watch*"
    ]);
    expect(merged.content_scripts?.[1]?.exclude_matches).toEqual([
      "https://www.bilibili.com/list/*"
    ]);
  });

  it("web_accessible_resources 的 matches 跟随内容脚本扩展，但只保留 origin", () => {
    const merged = mergeSiteManifests(
      [
        site(),
        site({
          id: "youtube",
          contentMatches: ["https://www.youtube.com/watch*"],
          hostPermissions: ["https://www.youtube.com/*"]
        })
      ],
      base({
        web_accessible_resources: [
          {
            resources: ["content-scripts/content.css"],
            // WXT 会把内容脚本的 matches 原样写进这里，包括带具体路径的模式。
            matches: [
              "https://www.bilibili.com/video/*",
              "https://www.bilibili.com/list/*",
              "https://www.bilibili.com/*"
            ]
          }
        ]
      })
    );
    expect(merged.web_accessible_resources?.[0]?.matches).toEqual([
      "https://www.bilibili.com/*",
      "https://www.youtube.com/*"
    ]);
  });

  it("web_accessible_resources 的 matches 保留通配 host 与 all_urls，丢弃具体路径", () => {
    const merged = mergeSiteManifests(
      [
        site({
          contentMatches: ["*://*.bilibili.com/video/*", "<all_urls>"],
          hostPermissions: ["*://*.bilibili.com/*"]
        })
      ],
      base({
        web_accessible_resources: [
          { resources: ["content.css"], matches: ["https://example.com/app/*"] }
        ]
      })
    );
    expect(merged.web_accessible_resources?.[0]?.matches).toEqual([
      "https://example.com/*",
      "*://*.bilibili.com/*",
      "<all_urls>"
    ]);
  });

  it("web_accessible_resources 的 match pattern 缺 scheme 时构建期报错", () => {
    expect(() =>
      mergeSiteManifests(
        [site({ contentMatches: ["www.bilibili.com/video/*"] })],
        base({
          web_accessible_resources: [
            { resources: ["content.css"], matches: ["https://www.bilibili.com/*"] }
          ]
        })
      )
    ).toThrow(/match pattern/);
  });

  it("非法 site.json：缺 id、字段类型错、id 重复都报错", () => {
    expect(() => parseSiteManifest({})).toThrow();
    expect(() => parseSiteManifest({ id: "x", contentMatches: "not-array" })).toThrow();
    expect(() => parseSiteManifest({ id: "x", contentMatches: [1] })).toThrow();
    expect(() =>
      mergeSiteManifests([site(), site()], base())
    ).toThrow(/id 重复/);
    // 返回新对象：入参不被修改。
    const original = base();
    mergeSiteManifests([site()], original);
    expect(original.content_scripts?.[0]?.matches).toEqual(["https://www.bilibili.com/video/*"]);
  });
});
