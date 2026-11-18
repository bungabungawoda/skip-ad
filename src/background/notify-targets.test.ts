import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentScriptMatchPatterns, settingsChangeTargets } from "./notify-targets";

const SITES_DIR = fileURLToPath(new URL("../sites", import.meta.url));

/** 磁盘上所有站点的内容脚本匹配模式：与后台的通知范围必须一致。 */
function diskPatterns(): string[] {
  const patterns = new Set<string>();
  for (const entry of readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(SITES_DIR, entry.name, "site.json"), "utf8")) as {
      contentMatches?: string[];
    };
    for (const pattern of manifest.contentMatches ?? []) patterns.add(pattern);
  }
  return [...patterns];
}

describe("设置通知的目标地址", () => {
  it("覆盖每个站点 site.json 里的全部匹配模式", () => {
    const patterns = contentScriptMatchPatterns();
    for (const expected of diskPatterns()) {
      expect(patterns).toContain(expected);
    }
    // 去重后不会重复推送。
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("设置变更通知包含扩展设置页", () => {
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
    });
    expect(settingsChangeTargets().optionsUrl).toBe("chrome-extension://test/options.html");
    for (const expected of diskPatterns()) {
      expect(settingsChangeTargets().contentUrls).toContain(expected);
    }
    vi.unstubAllGlobals();
  });
});
