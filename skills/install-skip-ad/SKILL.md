---
name: install-skip-ad
description: 一句话装好跳过广告扩展（skip-ad）：先确认用户有没有自己的模型 API Key，再决定是否安装 magpie 本地代理，然后拉取代码构建 Chrome 扩展并给出加载和连接步骤。当用户要安装、更新或重新配置 skip-ad、跳过广告扩展时调用。
---

# 一句话装好跳过广告扩展

目标：用户只说一次「装好」，先确认模型从哪里来，再把能自动做的做完，最后给出不超过 5 行的收尾清单。

## 先确认环境

- Node.js 22.13 以上：`node -v`。版本不够就用系统包管理器升级；没有 Node 时先说明要装，得到同意再装。
- Chrome 120 以上。
- 能访问 GitHub 和 npm。

不要读取或改写用户的 Cookie、登录态和浏览器配置，也不要关闭用户已经打开的 Chrome。

## 1. 先问模型来源

只问一句：「你有自己的模型 API Key 吗，比如 OpenAI、Gemini、DeepSeek 的？」

- 有：不要安装 magpie，直接跳到第 5 步构建。连接时让用户自己在设置页选服务商、粘贴 Key。
- 没有：进入第 2 步，先解释 magpie 并征得同意，不要直接安装。
- 不想用 magpie，也不想申请 Key：告诉用户视频里的口播广告无法分析，YouTube 片头广告仍会自动跳过，然后结束。

没有用户明确同意，不要安装 magpie 或任何其他软件。

## 2. 解释 magpie 并征得同意（仅在没有 Key 时）

先把这几点说清楚，再明确问一句「要安装 magpie 吗？」：

- magpie 是一个跑在本机的反向代理，能把电脑上已经登录的 AI 应用（Claude Code、Codex 等）或本地模型变成一个本地接口，扩展不用申请新的 Key 就能用。
- 请求先发到本机 `127.0.0.1:3425`，再由 magpie 转给原来的服务商，用的是你已登录的账号。
- 风险：magpie 是第三方软件，能读取本机 AI 应用的登录信息；用订阅账号给其他程序发请求，可能不符合服务商条款，存在被限流或封号的风险；转发内容怎么处理，取决于 magpie 的实现和配置。

用户同意后再继续；拒绝就结束，不要安装。

## 3. 安装并启动 magpie

已经装过就跳过安装。判断方式：`command -v magpie` 能找到，或 macOS 上有 `/Applications/magpie.app`。

macOS / Linux：

```sh
curl -fsSL https://usemagpie.ai/install.sh | sh
```

Windows：让用户从 https://github.com/yetone/magpie-releases/releases 下载安装包，装好后继续。

先探测网关是否已经在运行：

```sh
curl -fsS --max-time 2 http://127.0.0.1:3425/v1/models >/dev/null && echo running
```

没有运行就启动。桌面版打开应用即可；没有桌面环境时用：

```sh
nohup magpie serve >/tmp/magpie.log 2>&1 &
```

## 4. 准备一个可用模型

```sh
magpie models
```

- 列表为空：magpie 里还没有可用账号。运行 `magpie web` 打开界面，让用户自己登录已有订阅或添加一个 Key。这一步只能由用户完成，不要编造 Key。完成后重新执行 `magpie models`。
- 列表非空：挑一个能对话的文本模型，原样记下它打印的完整 id。id 可能是 `服务商/模型`，也可能是 `group/...` 或 `auto/...`，不要自己改写。优先选用户已经登录的服务商；拿不准就取列表里第一个对话模型，并在收尾时说明可以换。

## 5. 构建扩展

```sh
git clone https://github.com/bungabungawoda/skip-ad ~/skip-ad
cd ~/skip-ad
npm ci
npm run build
```

目录已经存在时不要重复克隆：确认 `git -C ~/skip-ad remote get-url origin` 指向这个仓库后，执行 `git pull --ff-only` 再构建。`npm ci` 失败就退回 `npm install`。以 `output/chrome-mv3/manifest.json` 存在作为构建成功的标准。

## 6. 在 Chrome 里加载

打开扩展页：

- macOS：`open -a "Google Chrome" "chrome://extensions"`
- Linux：`google-chrome "chrome://extensions"`，没有就换 `chromium`
- Windows：`start chrome chrome://extensions`

告诉用户点三下：

1. 打开右上角「开发者模式」。
2. 点「加载已解压的扩展程序」。
3. 选择 `~/skip-ad/output/chrome-mv3`。

不要用命令行参数加载扩展：那会另开一个浏览器配置，用户日常浏览时看不到扩展。

## 7. 连接模型

扩展第一次安装会自动打开设置页。

- 用 magpie：API 地址填 `http://127.0.0.1:3425/v1`，Key 留空，模型名填第 4 步记下的完整 id，点「连接」。
- 用自己的 Key：让用户在设置页选服务商，或把服务商的接口地址粘到「API 地址」，再自己粘贴 Key，点「连接」。不要向用户索要 Key，也不要把 Key 写进命令、文件或日志。

看到「已连接」即可。

## 收尾

用不超过 5 行告诉用户：装在哪里、用的哪个模型、还需要点哪三下、以后怎么更新（`cd ~/skip-ad && git pull && npm run build`，然后在扩展页点刷新）。不要把命令日志整段贴出来。

## 出问题时

- 用 magpie 时 `curl http://127.0.0.1:3425/v1/models` 失败：magpie 没启动或端口被占用，先看 `magpie serve` 的输出。
- 连接时报鉴权错误：确认 Key 框是空的，地址是 `http://127.0.0.1:3425/v1`。
- 连接时报模型不存在：回到 `magpie models` 原样复制完整 id，不要自己拼。
