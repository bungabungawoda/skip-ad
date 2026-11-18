#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const OUTPUT = join(ROOT, "output");
const EXTENSION = join(OUTPUT, "chrome-mv3");
const RELEASE = join(ROOT, "release");
const STORE = join(RELEASE, "store");
const REPO_URL = process.env.REPO_URL ?? "https://github.com/bungabungawoda/skip-ad";
const PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;
const SUPPORT_URL = `${REPO_URL}/issues`;
const SHORT_DESCRIPTION =
  "自动快进 YouTube 平台广告，并用你自己的 AI 服务识别、跳过视频内的推广片段。";
const SHORT_DESCRIPTION_EN =
  "Skip platform ads automatically and use your own AI service to find and skip sponsored segments in videos.";
const SLEEP = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function log(message) {
  console.log(message);
}

function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROME_PATH 指向的文件不存在：${explicit}`);
    return explicit;
  }

  const names =
    process.platform === "win32"
      ? ["chrome.exe"]
      : ["Google Chrome for Testing", "chrome", "chromium"];
  const direct =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome for Testing\\Application\\chrome.exe"
          ]
        : [
            "/usr/bin/google-chrome-for-testing",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser"
          ];

  for (const candidate of direct) {
    if (existsSync(candidate)) return candidate;
  }

  const roots = [
    join(homedir(), ".chrome-test-daemon", "chrome"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : ""
  ].filter(Boolean);

  for (const root of roots) {
    const found = findFile(root, names, 7);
    if (found) return found;
  }

  throw new Error(
    "找不到 Chrome for Testing。安装 Chrome for Testing，或设置 CHROME_PATH 指向可执行文件后重试。"
  );
}

function findFile(directory, names, depth) {
  if (depth < 0 || !existsSync(directory)) return "";
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.isFile() && names.includes(entry.name)) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(join(directory, entry.name), names, depth - 1);
    if (found) return found;
  }
  return "";
}

function extensionId(directory) {
  const hex = createHash("sha256").update(directory).digest("hex").slice(0, 32);
  return [...hex].map((character) => String.fromCharCode(97 + parseInt(character, 16))).join("");
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForCdp(base, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome 还在启动，继续等。
    }
    await SLEEP(100);
  }
  throw new Error("Chrome 调试端口没有在预期时间内启动。");
}

class CdpPage {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.onopen = resolveReady;
      this.socket.onerror = () => rejectReady(new Error("连接 Chrome 调试端口失败。"));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  async open() {
    await this.ready;
  }

  send(method, params = {}) {
    return new Promise((resolveSend, rejectSend) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method} 超时。`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本执行失败。");
    }
    return result.result.value;
  }

  async waitFor(expression, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression).catch(() => false);
      if (value) return value;
      await SLEEP(100);
    }
    throw new Error(`等待超时：${label}`);
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }]
    });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", "页面加载");
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`找不到元素：${selector}`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
  }

  async screenshot(path) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true
    });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

async function openTarget(base, url) {
  const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`打开 Chrome 标签页失败：${response.status}`);
  const target = await response.json();
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.open();
  return { target, page };
}

async function closeTarget(base, target, page) {
  page.close();
  await fetch(`${base}/json/close/${target.id}`).catch(() => undefined);
}

async function clickNav(page, label, expected) {
  const clicked = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll("nav button")].find(
      (element) => element.textContent.trim() === ${JSON.stringify(label)}
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到导航：${label}`);
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(expected)})`,
    expected
  );
  await SLEEP(700);
}

async function ensureVisibleInViewport(page, selector, margin = 12) {
  const before = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  })()`);
  if (!before) throw new Error(`找不到元素：${selector}`);
  if (before.bottom <= before.viewport - margin && before.top >= 0) return;

  await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: "nearest" });
    document.querySelector("main")?.scrollBy(0, ${margin});
  })()`);
  await SLEEP(300);

  const after = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  })()`);
  if (!after || after.top < 0 || after.bottom > after.viewport - margin / 2) {
    throw new Error(`元素没有完整进入截图区域：${selector}`);
  }
}

async function captureDataUrl(base, html, width, height, output) {
  const { target, page } = await openTarget(base, "about:blank");
  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.setViewport(width, height);
    await page.navigate(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
    await SLEEP(400);
    await page.screenshot(output);
  } finally {
    await closeTarget(base, target, page);
  }
}

function playerHtml(playerImage) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #f4f4f5; }
  body { display: flex; align-items: center; justify-content: center; }
  img { display: block; max-width: calc(100% - 80px); max-height: calc(100% - 80px); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
</style>
</head>
<body><img alt="" src="data:image/png;base64,${playerImage}"></body>
</html>`;
}

function promoHtml(iconImage) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  body {
    padding: 28px;
    background: linear-gradient(135deg, #ecfdf5, #dcfce7);
    color: #14532d;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .top { display: flex; align-items: center; gap: 14px; }
  .icon { width: 56px; height: 56px; border-radius: 14px; box-shadow: 0 8px 20px rgba(22,163,74,.25); }
  .brand { font-size: 11px; font-weight: 700; letter-spacing: .14em; color: #166534; }
  .title { margin-top: 2px; font-size: 28px; font-weight: 700; line-height: 1.15; }
  .sub { font-size: 13px; color: #166534; opacity: .85; }
  .bar { position: relative; height: 7px; margin-top: 14px; border-radius: 999px; background: rgba(22,101,52,.16); }
  .played { position: absolute; left: 0; top: 0; width: 58%; height: 100%; border-radius: 999px; background: #16a34a; }
  .mark { position: absolute; left: 58%; top: 0; width: 16%; height: 100%; border-radius: 999px; background: #f2636a; }
  .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 11px; color: #166534; opacity: .8; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid rgba(20,83,45,.15); border-radius: 999px; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.08); font-size: 10px; font-weight: 600; opacity: 1; }
</style>
</head>
<body>
  <div class="top">
    <img class="icon" alt="" src="data:image/png;base64,${iconImage}">
    <div>
      <div class="brand">SKIP AD</div>
      <div class="title">自动跳过视频广告</div>
      <div class="sub">平台广告 + 视频内推广片段</div>
    </div>
  </div>
  <div>
    <div class="bar"><div class="played"></div><div class="mark"></div></div>
    <div class="foot"><span>进度条色块标出推广片段</span><span class="pill">▶ 12:30</span></div>
  </div>
</body>
</html>`;
}

function listingMarkdown(zipName) {
  return [
    "# Chrome Web Store 上架素材",
    "",
    `- 扩展名称：${PACKAGE.name === "skip-ad" ? "跳过助手（Skip Ad）" : PACKAGE.name}`,
    `- 版本：${PACKAGE.version}`,
    "- 分类：生产工具 / Productivity",
    "- 语言：中文（简体）与 English（两个语言分别填写商店文案）",
    `- 主页：${REPO_URL}`,
    `- 支持：${SUPPORT_URL}`,
    `- 隐私政策：${PRIVACY_URL}`,
    `- 扩展包：${zipName}`,
    "",
    "## 中文（简体）",
    "",
    "### 短描述",
    "",
    SHORT_DESCRIPTION,
    "",
    "### 详细描述",
    "",
    "Skip Ad 是一个 Chrome 扩展，帮你在哔哩哔哩和 YouTube 上看视频时少看广告。",
    "",
    "- YouTube 片头广告不用配置，自动跳到结尾；跳不过去就静音快进。",
    "- 视频里由创作者念的推广口播，配置一次自己的 AI 服务后，播放到开头自动跳过。",
    "- 进度条上的色块标出推广片段；鼠标移上去会出现跳转按钮，也可以手动点。",
    "- 右上角提示「已跳过」，5 秒内可以撤销；撤销后本次播放不再自动跳这一段。",
    "",
    "需要你自己的 AI 服务 Key。扩展不提供 Key，也没有开发者服务器；分析内容会直接发送给你选定的服务商。完整的数据说明和同意方式见隐私政策。",
    "",
    "### 权限说明",
    "",
    "- `storage`：在本机保存设置、API Key、分析缓存和跳过统计。",
    "- `www.bilibili.com`、`www.youtube.com`：在视频页读取视频信息、字幕和弹幕，并画出进度条色块。",
    "- 内置 AI 服务商地址：连接你选择的服务商，发送判断推广片段所需的文本。",
    "- 自定义端点：保存时单独申请访问权限，只访问你填写的地址。",
    "",
    "### 数据披露",
    "",
    "- 处理的数据：身份验证信息（API Key）、网站内容（视频标题、UP 主、简介、字幕、弹幕、视频 ID）。",
    "- 用途：只用于判断和跳过视频广告。",
    "- 出售数据：否。个性化广告：否。信用评估或贷款：否。",
    "- 数据接收方：用户自己选定的 AI 服务商，以及哔哩哔哩/YouTube 的站内接口。",
    "- 数据删除：断开当前服务商、清除缓存和统计，或卸载扩展。",
    "",
    "## English",
    "",
    "### Short description",
    "",
    SHORT_DESCRIPTION_EN,
    "",
    "### Detailed description",
    "",
    "Skip Ad is a Chrome extension that reduces the ads you see while watching videos on Bilibili and YouTube.",
    "",
    "- YouTube platform ads need no setup. The extension jumps to the ad's end; if that fails, it plays the ad muted at high speed.",
    "- For sponsored segments spoken by the creator, configure your own AI service once. Playback skips the segment when it starts.",
    "- Colored marks on the progress bar show sponsored segments. Hover over a mark to use the jump button, or click it yourself.",
    "- A notice in the corner says the segment was skipped. You can undo within 5 seconds, and that segment will not auto-skip again during this playback.",
    "",
    "You need your own API key for an AI service. The extension provides no key and runs no developer server. Analysis content goes directly to the provider you choose. See the privacy policy for full data details and consent information.",
    "",
    "### Permissions",
    "",
    "- `storage`: saves settings, the API key, analysis cache, and skip stats on this device.",
    "- `www.bilibili.com` and `www.youtube.com`: reads video information, captions, and comments on video pages and draws marks on the progress bar.",
    "- Built-in AI provider addresses: connects to the provider you choose and sends the text needed to detect sponsored segments.",
    "- Custom endpoint: asks for access separately when saved and only accesses the address you enter.",
    "",
    "### Data disclosure",
    "",
    "- Data processed: authentication information (API key) and website content (video title, creator, description, captions, comments, and video ID).",
    "- Purpose: only to detect and skip video ads.",
    "- Selling data: no. Personalized advertising: no. Credit or loan assessment: no.",
    "- Data recipients: the AI provider you choose and Bilibili/YouTube site APIs.",
    "- Data deletion: disconnect the current provider, clear cache and stats, or uninstall the extension.",
    "",
    "### Store listing notes",
    "",
    "- Enter the English text in the English (United States) store listing and the Chinese text in the Chinese (Simplified) listing.",
    "- The extension name and description in `manifest.json` are localized through `_locales/en` and `_locales/zh_CN`.",
    "- Upload the same screenshots and promotional image for both listings unless localized screenshots are available.",
    "",
    "## 素材文件",
    "",
    "- `icon-128.png`：128×128 商店图标。",
    "- `screenshot-first-run-1280x800.png`：首次安装的隐私说明页。",
    "- `screenshot-sites-1280x800.png`：站点开关页。",
    "- `screenshot-connection-1280x800.png`：模型连接页。",
    "- `screenshot-provider-1280x800.png`：服务商下拉列表。",
    "- `screenshot-player-1280x800.png`：进度条色块与跳转按钮示意。",
    "- `promo-440x280.png`：商店促销图。",
    "",
    "## 提交前检查",
    "",
    "- [ ] `PRIVACY.md` 已推到公开仓库的 `main` 分支，链接可以直接打开。",
    "- [ ] GitHub Issues 已开启，支持链接可以直接打开。",
    "- [ ] 扩展包 `manifest.json` 在 zip 根目录。",
    "- [ ] 截图里没有真实 Key、真实视频画面、字幕或个人信息。",
    "- [ ] 商店隐私问卷按上面的数据披露填写，并完成 Limited Use 声明。",
    "- [ ] 商店文案写明需要自带 AI Key，并声明与哔哩哔哩、YouTube 无隶属关系。",
    "- [ ] Chrome Web Store 的 English (United States) 与 中文（简体）两个语言都填写名称、短描述和详细描述。",
    "",
    "与哔哩哔哩、YouTube 无隶属关系。相关名称和商标归各自权利人所有。",
    "",
    "Skip Ad is not affiliated with Bilibili or YouTube. All names and trademarks belong to their respective owners."
  ].join("\n");
}

function findZip() {
  const expected = join(OUTPUT, `${PACKAGE.name}-${PACKAGE.version}-chrome.zip`);
  if (existsSync(expected)) return expected;
  const candidates = readdirSync(OUTPUT)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => join(OUTPUT, name))
    .sort();
  if (candidates.length === 0) throw new Error("wxt zip 没有生成 zip 文件。");
  return candidates[candidates.length - 1];
}

function runZip() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["wxt", "zip"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore"
      });
    } catch {
      // Chrome 可能已经退出。
    }
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), SLEEP(2000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  if ([...SHORT_DESCRIPTION].length > 132) {
    throw new Error("商店短描述超过 132 个字符。");
  }
  if ([...SHORT_DESCRIPTION_EN].length > 132) {
    throw new Error("English store short description exceeds 132 characters.");
  }

  log("构建并打包扩展……");
  runZip();
  const zip = findZip();
  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(STORE, { recursive: true });
  copyFileSync(zip, join(RELEASE, basename(zip)));
  copyFileSync(join(ROOT, "src/public/icon/128.png"), join(STORE, "icon-128.png"));
  copyFileSync(join(ROOT, "PRIVACY.md"), join(RELEASE, "PRIVACY.md"));
  copyFileSync(join(ROOT, "LICENSE"), join(RELEASE, "LICENSE"));
  const notices = join(ROOT, "THIRD_PARTY_NOTICES.md");
  if (existsSync(notices)) copyFileSync(notices, join(RELEASE, "THIRD_PARTY_NOTICES.md"));

  const chrome = findChrome();
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "skip-ad-store-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=zh-CN",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--remote-debugging-port=${port}`,
      "--window-size=1280,800",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let chromeErrors = "";
  child.stderr.on("data", (chunk) => {
    chromeErrors += String(chunk);
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForCdp(base);
    const id = extensionId(EXTENSION);
    const { target, page } = await openTarget(base, "about:blank");
    try {
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.setViewport(1280, 800);
      await page.navigate(`chrome-extension://${id}/options.html`);
      await page.waitFor("document.body?.innerText.includes('设置')", "设置页");
      const bodyText = await page.evaluate("document.body?.innerText ?? ''");
      if (bodyText.includes("已被屏蔽") || bodyText.includes("ERR_BLOCKED_BY_CLIENT")) {
        throw new Error("扩展没有在 Chrome 里加载成功，请确认使用的是 Chrome for Testing。");
      }
      await SLEEP(1000);
      await ensureVisibleInViewport(page, 'a[href$="PRIVACY.md"]');
      await page.screenshot(join(STORE, "screenshot-first-run-1280x800.png"));

      await clickNav(page, "站点", "每个网站的启用与能力开关");
      await page.screenshot(join(STORE, "screenshot-sites-1280x800.png"));

      await clickNav(page, "模型连接", "服务商");
      await page.screenshot(join(STORE, "screenshot-connection-1280x800.png"));
      await page.click("#provider");
      await page.waitFor(
        "document.querySelectorAll('[role=option]').length >= 8",
        "服务商下拉"
      );
      await SLEEP(300);
      await page.screenshot(join(STORE, "screenshot-provider-1280x800.png"));
    } finally {
      await closeTarget(base, target, page);
    }

    const playerImage = readFileSync(join(ROOT, "images/player-skip.png")).toString("base64");
    await captureDataUrl(
      base,
      playerHtml(playerImage),
      1280,
      800,
      join(STORE, "screenshot-player-1280x800.png")
    );

    const iconImage = readFileSync(join(ROOT, "src/public/icon/128.png")).toString("base64");
    await captureDataUrl(
      base,
      promoHtml(iconImage),
      440,
      280,
      join(STORE, "promo-440x280.png")
    );

    writeFileSync(join(STORE, "listing.md"), listingMarkdown(basename(zip)));
    log(`完成。商店素材在 ${STORE}`);
    log(`扩展包在 ${join(RELEASE, basename(zip))}`);
  } catch (error) {
    if (chromeErrors) console.error(chromeErrors);
    throw error;
  } finally {
    await stopChrome(child);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // 临时配置目录清不掉不影响素材生成。
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
