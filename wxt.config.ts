import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { mergeSiteManifests, type WxtManifest } from "./src/wxt/manifest-sites";
import { parseSiteManifest } from "./src/core/plugin/manifest";
import { LLM_PRESETS } from "./src/core/ports/llm/config";
import { DEFAULT_DECISION_ENDPOINT } from "./src/core/ports/decision/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/** 常用服务商的 API 地址：装的时候一次给，连接时就不再弹窗。 */
function providerOrigins(): string[] {
  return LLM_PRESETS.map((preset) => `${new URL(preset.baseUrl).origin}/*`);
}

/**
 * 决策接口的 host 权限：后台代发的请求带 chrome-extension:// 这个 Origin，
 * 没有 host 权限时 Chrome 按普通跨域请求处理，服务端不给 CORS 头就被拦掉。
 */
function decisionOrigin(): string {
  return `${new URL(DEFAULT_DECISION_ENDPOINT).origin}/*`;
}

/** 扫描各网站目录下的 site.json：它是权限与匹配的唯一来源，目录缺失该文件时报错。 */
function loadSiteManifests() {
  const sitesDir = join(srcDir, "sites");
  return readdirSync(sitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(sitesDir, entry.name, "site.json");
      return parseSiteManifest(JSON.parse(readFileSync(file, "utf8")), file);
    });
}

export default defineConfig({
  srcDir: "src",
  outDir: "output",
  publicDir: "src/public",
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": srcDir
      }
    }
  }),
  hooks: {
    // WXT 会把 process.env.NODE_ENV 定义成 --mode 的值；自定义 release 模式
    // 因此会挑到 React 开发版。构建时统一钉成 production，开发服务器不受影响。
    "vite:build:extendConfig": (_entrypoints, viteConfig) => {
      viteConfig.define = {
        ...viteConfig.define,
        "process.env.NODE_ENV": JSON.stringify("production")
      };
      // 浏览器扩展不走 RSC：依赖里的 "use client" 只是给 React 框架的边界标记，
      // 不会被打包器保留也不需要保留。它当前只会刷屏，不表示构建有问题。
      viteConfig.build = {
        ...viteConfig.build,
        rolldownOptions: {
          ...viteConfig.build?.rolldownOptions,
          onwarn(warning, warn) {
            if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
            warn(warning);
          }
        }
      };
    },
    // 写出前合并各站 site.json：host_permissions 与内容脚本 matches 不再手写。
    "build:manifestGenerated": (_wxtConfig, manifest) => {
      Object.assign(manifest, mergeSiteManifests(loadSiteManifests(), manifest as WxtManifest));
    }
  },
  manifest: {
    default_locale: "en",
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    action: {
      default_title: "__MSG_actionTitle__"
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png"
    },
    permissions: ["storage"],
    host_permissions: [...providerOrigins(), decisionOrigin()],
    // 本地网关（magpie 这类）跑在 http://127.0.0.1:<端口>，权限模式不能写端口。
    optional_host_permissions: ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"],
    minimum_chrome_version: "120",
    content_security_policy: {
      // 回环地址单独放行：本地网关走 http，host 权限不豁免 CSP，不写这里就连不上。
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*"
    }
  }
});
