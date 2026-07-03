# mail-relay

用自己的域名收发邮件、数据完全自持的个人邮箱系统。单个 Cloudflare Worker 承载收信存储与后台，发送层抽象为可插拔 Provider（当前实现 Resend）。数据落在 Durable Object SQLite + R2，无需 D1、无需自建服务器。

## 为什么用它

- **不用服务器，白嫖 Cloudflare 免费额度**：收信、存储、后台、发信编排全跑在 Cloudflare Workers + Durable Object + R2 上，个人用量基本落在免费档内。没有 VPS 账单，也不用管系统补丁、宕机、备份。
- **用自己的域名，前缀随便起**：配好 catch-all（`全收`规则），`任意前缀@你的域名` 都能收进来——给每个网站注册用一个专属地址（如 `github@你的域名`、`shop@你的域名`），哪个泄露了一眼就看得出。
- **数据在自己手里**：邮件、附件、原始 .eml 都存在你自己的 Cloudflare 账号（DO SQLite + R2），不经第三方邮箱托管；换发信服务商也不影响历史邮件。
- **不用自建邮件服务器**：省掉 Postfix/Dovecot 那一套，也不用操心 IP 信誉、反垃圾、TLS 证书续期这些传统自建邮箱的苦活——收信的 MX 由 Cloudflare 兜底，SPF/DKIM/DMARC 由 Cloudflare 与发信 Provider 处理。
- **一条命令部署**：`wrangler deploy` 把前端、后台、Durable Object、静态资源一起发上去；日常改配置在后台「设置」页即改即生效。

也说清楚它的边界：只能用浏览器后台收发信，**不支持 Foxmail / Outlook 等 IMAP/POP3 客户端**接入；发信依赖第三方 Provider（如 Resend）及其配额。要用邮件客户端或做大批量群发，传统自建邮箱更合适。

## 和「Cloudflare 原生转发」有什么不同

如果只想把 `你@域名` 的邮件转进 QQ 邮箱看，**Cloudflare 原生转发（Email Routing 直接转发到目标邮箱）零代码、零部署，更省事**——本项目并不否定它，甚至自己也内置了转发功能。真正的区别在于：

- **能用域名发信、回信**：原生转发只收不发。邮件转进 QQ 后你去回信，对方看到的发件人是你的 QQ 地址，不是 `你@域名`。本项目集成了发信，能以 `admin@你的域名` 主动发、回复也保持域名身份并归并到同一会话——这是最实质的差别。
- **数据在自己手里**：原生转发是把邮件副本交给腾讯/QQ 保管；本项目的邮件、附件、原始 .eml 都落在你自己的 Cloudflare 账号（DO SQLite + R2）里。
- **catch-all 真正可管理**：原生转发会把 `任意前缀@你的域名` 全挤进同一个 QQ 收件箱、混作一团；本项目有独立后台，能按收件前缀/发件人区分、规则归档、通讯录、搜索、会话视图、下载原始 .eml。
- **收信不看第三方脸色**：转发会改变邮件来源，容易触发目标邮箱的 SPF/DMARC 对齐问题而被判垃圾或退回；本项目收信直接落自己的库，不受目标邮箱反垃圾策略影响。而且它**自带转发**——可以「本地存档 + 同时转发到 QQ」两不误，比纯转发多一份自己的备份。

一句话：只想把域名邮件倒进 QQ 看看，用原生转发就够了；想用域名把邮件真正收、发、管起来、且数据自持，才需要它。

## 功能

- **收信**：Cloudflare Email Routing（MX）把发往 `任意前缀@你的域名` 的邮件转给 Worker，原始 .eml 落 R2 保底，再由 Durable Object 解析入库、线程归并、按规则自动归档。
- **转发**：后台可配置转发规则，按邮件头 发件人/收件人 匹配来信并转发到指定邮箱（走 Worker 内 `message.forward()`，与 CF 原生转发不同——它先经过本系统，收信与转发两不耽误）；每条规则可选择「转发并存档」或「转发后不存档」，转发失败自动回退存档保底。目标地址须为 Cloudflare 邮箱路由里已验证的 Destination。
- **后台**：浏览器登录后查看邮件列表 / 详情 / 会话视图，下载附件与原始 .eml；支持标记已读·未读、移入垃圾邮件、删除（两段式：先入废纸篓，废纸篓内再删则彻底清理含 R2）。收件箱有「检查新邮件」按钮手动拉取（不做定时轮询，省 Worker 额度）。界面**适配移动端**（顶部汉堡 + 抽屉侧栏）。邮件正文用 sandboxed iframe + CSP 安全渲染，外链图片默认不加载（防追踪像素与 XSS）。
- **通讯录**：独立通讯录页（增删改查）；写邮件时收件人输入触发通讯录联想下拉；发送成功的收件人自动入库；收信详情可一键把发件人「存入通讯录」（以邮箱判重）。
- **发信**：独立撰写页（非弹窗）+ 原生富文本编辑器（加粗/斜体/列表/链接），可上传附件、回复自动引用原文；配置「主域」后新邮件默认发件人为 `admin@主域`，回复则「谁收谁发」。Durable Object 编排通过激活的 Provider 发出；outbox 状态机记录 发送中 / 已送出 / 失败，失败按指数退避自动重试，「已发送」列表实时显示状态并可手动重试。
- **可插拔发送层**：Provider 是接口，Resend 只是第一个实现；后台可新增、测试、切换通道，零前端改动。
- **设置页**：主域名、修改管理密码、登录防爆破参数、每日发送配额与正文外置阈值，全部集中于 DO 内的 config 表，页面即改即生效，无需改环境变量或重新部署。
- **自持**：发出的内容 100% 存自己库里；切换服务商不影响历史追溯。

## 技术要点

- 单 Worker、代码模块化（`src/` 下 ingest / api / do / providers / mime / shared 分层），Wrangler 原生打包，无额外构建配置。
- 前端 `public/` 为原生 HTML/CSS/JS，无构建步骤；富文本用 `contenteditable`、提示/确认为自制 toast/dialog 组件，均零依赖。
- 业务配置（管理密码哈希、主域、防爆破、配额、阈值）集中在 DO 的 `config` 表，仅加密/签名根密钥 `CONFIG_MASTER_KEY`/`SESSION_SECRET` 保留为 secret。
- Durable Object 单实例串行：幂等去重、每日发送配额、outbox 状态机全部免锁。
- SQLite 只存索引与小正文；.eml、附件、超阈值 HTML 正文（>256KB）一律入 R2。
- 所有列表接口强制分页（`page` 默认 1，`pageSize` 默认 20、硬上限 100）。

## 快速部署概览

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create mail-relay      # 创建 R2 bucket
npx wrangler deploy                            # 部署 Worker（含 DO 与静态资源）

# 部署后再注入机密（顺序重要：先有 Worker 再灌 secret）
# 每个 secret put 都会立即用"当前代码 + 新 secret"重新发布一次，无需再手动 deploy
# 仅需两个根密钥；管理密码不再是 secret，改为首次访问后台时在页面上设置
npx wrangler secret put CONFIG_MASTER_KEY
npx wrangler secret put SESSION_SECRET
```

随后在 Cloudflare Email Routing 中配置路由规则：**必须**将 **Catch-all address (捕获所有地址)** 指向本 Worker（推荐，可接收任意前缀）；或者在 **Custom addresses (自定义地址)** 中为你需要的特定前缀单独配置指向本 Worker。未配置路由规则，邮件将在 Cloudflare 边缘被直接退回（`550 5.1.1 Address does not exist`）。

首次打开后台会引导你**设置管理密码**（PBKDF2 哈希存入 config 表，不落明文）。随后进入「设置」页填入**主域名**（写邮件默认发件人 `admin@主域`），并在「发送通道」录入 Resend API key → 测试 → 激活。

若要用「转发规则」把来信自动转发到常用邮箱，转发目标必须先在 Cloudflare 里验证为 Destination address：**Cloudflare 控制台 → 选中域名 → Email（电子邮件）→ Email Routing（电子邮件路由）→ Destination addresses（目标地址）→ Add destination address → 填入目标邮箱 → 打开该邮箱点验证链接 → 状态变 Verified**。未验证的地址无法作为转发目标（转发会失败，此时按回退逻辑仍会存档）。详见 [src/readme.md](src/readme.md) 的「配置转发规则」。

> ⚠️ **重要提示：SPF 配置（避免退信）**
> 如果你使用 Resend 发信，强烈建议使用**子域名**（如 `send.yourdomain.com`）来配置 Resend 的 DNS 记录，而主域名（`yourdomain.com`）保留给 Cloudflare Email Routing 收信。
> **如果必须在同一个主域名上同时收发**：Cloudflare 的 SPF 和 Resend 的 SPF **严禁**添加为两条独立的 TXT 记录（会导致全部进垃圾箱），必须合并为一条，例如：`v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`。

## 本地开发与测试

```bash
npm run dev         # wrangler dev（本地 miniflare 模拟 DO/R2）
npm run typecheck   # tsc --noEmit
npm test            # vitest 集成测试
```

## 完整文档

注册 Resend、DNS/SPF 合并、逐步部署、部署后配置变量的顺序、接通收信、激活发信、验证清单与常见问题，全部在 **[src/readme.md](src/readme.md)**。
