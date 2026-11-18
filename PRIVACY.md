# Skip Ad Privacy Policy and Data Use

Last updated: 2026-11-18

Applies to the Chrome extension **Skip Ad** ("the extension").

Project home: <https://github.com/bungabungawoda/skip-ad>

## Summary

The extension has no developer server and does not collect or sell your data. When you configure an AI service, video content and your API key go directly to the provider you choose so it can detect sponsored segments. That provider's own privacy policy governs how it handles the data.

## 1. Data the extension processes

| Data | Purpose | Stored in | Leaves this device |
| --- | --- | --- | --- |
| Provider, model name, API address, site switches, ad-type settings | Remember your settings | Extension storage (`chrome.storage.local`) | No |
| API key | Authenticate requests to the provider | Extension storage; sent in request headers | Yes, only to the provider you choose |
| Bilibili video title, creator, description, chapters, captions, comment sample | Detect sponsored segments in the video | Analysis requests and analysis cache only | Yes, to the model provider you choose |
| YouTube video ID, duration, captions | Detect sponsored segments in the video | Analysis requests and analysis cache only | Yes, to the model provider you choose |
| Analysis results and cache | Draw segments, perform skips, avoid repeat analysis | Extension storage | No; cache expires automatically and can be cleared |
| Segments skipped, time skipped, undo count | Local statistics | Extension storage | No |

The extension does not process account passwords, cookie contents, browsing history, location, contacts, payment information, or health information. It does not read or save cookies. When it calls Bilibili or YouTube site APIs, the browser handles sign-in state under each site's normal rules.

## 2. Who receives data

### The AI provider you choose

Analysis requests go directly from your browser to one of the addresses below. They do not pass through a server run by the extension author. For a custom endpoint, you enter the address yourself.

| Provider | Default API address |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| Kimi | `https://api.moonshot.cn/v1` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Claude | `https://api.anthropic.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini (decision model) | `https://generativelanguage.googleapis.com` |
| TypeSafe (decision model) | `https://api.typesafe.ai` |
| Custom endpoint | The address you enter in Settings |

Each provider's privacy policy, storage location, and data-use terms are published on its own website. Some providers may use input to improve their products; the extension cannot make promises on their behalf. The Settings page discloses how decision-model data is used. If you do not accept a provider's practices, do not configure it, or use a local or self-hosted endpoint you trust.

### Bilibili and YouTube

The extension requests video-page data, captions, and comments from the video sites to detect sponsored segments. Those requests are subject to each site's privacy policy, like any other web request.

### The extension author

The extension author does not receive, store, or sell this data. The extension has no developer backend, analytics SDK, advertising SDK, or user account system.

## 3. Consent

When you choose a provider, enter an API key, and click Connect, you are asking the extension to send the content needed for analysis to that provider. The first time you connect a custom endpoint, the browser asks separately whether to allow access to that address. If you decline, no request is sent to that address.

You can withdraw consent at any time:

- Disconnect the current provider under Model connection to delete its key and connection information.
- Clear the analysis cache and skip statistics in Settings.
- Uninstall the extension to delete all data it stored in the browser.

Disconnecting removes only the currently selected provider. Keys for other providers you connected before may remain on this device. To delete all data at once, uninstall the extension or clear its data on the browser's extension management page.

Without an AI service configured, YouTube platform-ad skipping still works; in-video sponsored-segment analysis does not run. If you do not accept this policy, do not configure an AI service or use the analysis feature.

## 4. Retention

- Local settings and API keys: kept until you disconnect, clear them, or uninstall the extension.
- Analysis cache: expires automatically according to the extension code and can be cleared manually in Settings.
- Skip statistics: kept until you clear them or uninstall the extension.
- Extension author: no data is retained.

## 5. Security

- Built-in providers use HTTPS. A custom endpoint is your choice; a local gateway may use HTTP on a loopback address.
- API keys are stored in Chrome extension storage and protected by your operating-system account and browser configuration. This is not a separate encrypted vault; anyone who can open this browser profile may be able to read them.
- Content scripts cannot read keys from extension storage. The Settings page, popup, and background service worker can.
- Keys are never written into analysis prompts or extension logs.
- The extension sends only the content needed to detect sponsored segments, not account information or full browsing history.
- Third-party provider security is outside the extension author's control. Choose a provider appropriate for the sensitivity of the content you send.

## 6. Children

The extension is not directed at children and does not intentionally collect children's personal information. If you believe a child used the extension and sent personal information, contact the maintainer through the address below.

## 7. Cross-border processing

The provider you choose may process data in other countries or regions. Its privacy policy governs the location and rules. If you do not accept cross-border processing, do not configure that provider, or use a local or self-hosted endpoint.

## 8. Policy updates

When this policy changes materially, the date at the top of this page is updated and the change is noted in the project README or release notes. If you do not agree with an updated policy, stop using the extension and uninstall it.

## 9. Contact

- General and privacy questions: <https://github.com/bungabungawoda/skip-ad/issues>
- Security vulnerabilities: use GitHub's private vulnerability reporting

## 10. Chrome Web Store data disclosure

To meet the Chrome Web Store User Data Policy, the extension discloses the following:

- Categories processed: authentication information (API key) and website content (video title, creator, description, captions, comments, video ID).
- Purpose: only to detect and skip video ads, the extension's single purpose.
- Selling data: no.
- Personalized advertising: no.
- Credit assessment, lending, or other financial purposes: no.
- Human review by the developer: no; the extension author does not receive this data.
- Recipients: the AI provider the user chooses and Bilibili/YouTube site APIs.
- Deletion: disconnect the current provider, clear cache/statistics, or uninstall the extension.

The extension follows the Chrome Web Store User Data Policy's Limited Use requirements: data is used only to provide or improve the extension's single purpose and is not used for sale, advertising profiles, credit assessment, or unrelated purposes.

---

# Skip Ad 隐私政策与数据使用说明

最后更新：2026-11-18

适用范围：Chrome 扩展 **Skip Ad**（以下简称“本扩展”）。

项目主页：<https://github.com/bungabungawoda/skip-ad>

## 一句话说明

本扩展没有开发者服务器，不收集、不出售你的数据。你配置 AI 服务后，视频内容和 API Key 会直接发送给你选定的服务商，用来判断视频里的推广片段；服务商如何处理这些数据，受它自己的隐私政策约束。

## 1. 本扩展处理哪些数据

| 数据 | 用途 | 保存位置 | 是否离开本机 |
| --- | --- | --- | --- |
| 服务商、模型名、API 地址、站点开关、类型策略 | 记住你的设置 | 浏览器扩展存储 `chrome.storage.local` | 否 |
| API Key | 请求服务商接口时做身份验证 | 浏览器扩展存储；请求时放在请求头里 | 是，只发给你选定的服务商 |
| B 站视频标题、UP 主、简介、章节、字幕、弹幕样本 | 判断视频内的推广片段 | 只放在分析请求和分析缓存里 | 是，发给你选定的模型服务商 |
| YouTube 视频 ID、时长、字幕 | 判断视频内的推广片段 | 只放在分析请求和分析缓存里 | 是，发给你选定的模型服务商 |
| 分析结果和缓存 | 画出片段、执行跳过、避免重复分析 | 浏览器扩展存储 | 否；缓存会自动过期，也可以手动清除 |
| 跳过段数、跳过时长、撤销次数 | 本机统计 | 浏览器扩展存储 | 否 |

本扩展不处理账号密码、Cookie 内容、浏览历史、位置、通讯录、支付信息或健康信息。扩展不读取、不保存 Cookie；访问哔哩哔哩和 YouTube 的站内接口时，登录态由浏览器按站点规则处理。

## 2. 数据发给谁

### 你选定的 AI 服务商

分析请求从你的浏览器直接发给下面这些地址之一，不经过扩展作者的服务器。使用自定义端点时，地址由你自己填写。

| 服务商 | 默认接口地址 |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| Kimi | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Claude | `https://api.anthropic.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini（决策模型） | `https://generativelanguage.googleapis.com` |
| TypeSafe（决策模型） | `https://api.typesafe.ai` |
| 自定义端点 | 你在设置页填写的地址 |

各服务商的隐私政策、数据保存地点和数据使用方式，以服务商官网公布的内容为准。部分服务商可能把输入用于改进自己的产品；扩展不能替服务商做承诺。设置页会提示决策模型的数据用途。如果你不接受某个服务商的做法，不要配置它，或者改用你信任的本地/自建端点。

### 哔哩哔哩和 YouTube

扩展会向视频站点请求视频页数据、字幕和弹幕，用来判断推广片段。这些请求和普通网页请求一样受站点隐私政策约束。

### 扩展作者

扩展作者不接收、不保存、不出售上述数据。本扩展没有开发者后端、统计 SDK、广告 SDK 或用户账号系统。

## 3. 数据同意

你在设置页选择服务商、填写 API Key 并点击“连接”，就表示你要求本扩展把分析所需内容发送给该服务商。首次连接自定义端点时，浏览器会单独询问是否允许访问该地址；拒绝后不会向该地址发送请求。

你可以随时收回同意：

- 在“模型连接”里断开当前服务商，删除当前服务商的 Key 和连接信息。
- 在设置页清除分析缓存和跳过统计。
- 卸载扩展，删除本扩展保存在浏览器里的全部数据。

注意：断开连接只删除当前选中的服务商，其他已经保存过的服务商 Key 仍可能留在本机。要一次删除全部数据，请卸载扩展，或在浏览器的扩展管理页清除本扩展的数据。

不配置 AI 服务时，YouTube 平台广告快进仍然可用；视频内推广片段分析不会运行。如果你不接受本政策，请不要配置 AI 服务或使用分析功能。

## 4. 保存期限

- 本地设置和 API Key：保存到你主动断开、清除或卸载扩展。
- 分析缓存：按扩展代码里的过期时间自动清理，也可以在设置页手动清除。
- 跳过统计：保存到你手动清除或卸载扩展。
- 扩展作者侧：不保存任何数据。

## 5. 安全

- 预设服务商使用 HTTPS。自定义端点由你决定；本地网关可以使用回环地址的 HTTP。
- API Key 保存在 Chrome 的扩展存储里，受你的操作系统账户和浏览器配置保护。它不是单独的加密保险箱；能打开这个浏览器配置的人可能读到它。
- 内容脚本不能读取扩展存储里的 Key；设置页、弹窗和后台 Service Worker 可以读取。
- Key 不会写进分析提示词，也不会写进扩展日志。
- 扩展只发送判断推广片段需要的内容，不发送账号信息或完整浏览历史。
- 第三方服务商的安全措施不在扩展作者控制范围内，请按你发送内容的敏感程度选择服务商。

## 6. 儿童

本扩展不面向儿童，也不会主动收集儿童的个人信息。如果你认为儿童使用了本扩展并发送了个人信息，请通过下面的联系方式联系维护者。

## 7. 跨境处理

你选择的服务商可能在其他国家或地区处理数据。具体处理地点和规则以服务商隐私政策为准；如果你不能接受跨境处理，请不要配置该服务商，或使用本地/自建端点。

## 8. 政策更新

本政策有实质变化时，会更新本页顶部的日期，并在项目 README 或版本说明里提示。如果你不同意更新后的政策，请停止使用并卸载扩展。

## 9. 联系方式

- 普通问题和隐私问题：<https://github.com/bungabungawoda/skip-ad/issues>
- 安全漏洞：优先使用 GitHub 的私密漏洞报告功能

## 10. Chrome Web Store 数据披露

为满足 Chrome Web Store 的用户数据政策，本扩展按下面的口径披露：

- 处理的数据类别：身份验证信息（API Key）、网站内容（视频标题、UP 主、简介、字幕、弹幕、视频 ID）。
- 用途：只用于判断和跳过视频广告，也就是本扩展的唯一用途。
- 出售数据：否。
- 个性化广告：否。
- 信用评估、贷款或其他金融用途：否。
- 开发者人工查看：否；扩展作者没有接收这些数据。
- 数据传输对象：用户自己选定的 AI 服务商，以及哔哩哔哩/YouTube 的站内接口。
- 数据删除：断开当前服务商、清除缓存/统计，或卸载扩展。

本扩展遵守 Chrome Web Store User Data Policy 的 Limited Use 要求：数据只用于提供或改进本扩展的单一用途，不用于出售、广告画像、信用评估或与本扩展无关的目的。
