# mail-relay

用自己的域名收发邮件、数据完全自持的个人邮箱系统。单个 Cloudflare Worker 承载收信存储与后台，发送层抽象为可插拔 Provider（当前实现 Resend）。数据落在 Durable Object SQLite + R2，无需 D1、无需自建服务器。

## 功能

- **收信**：Cloudflare Email Routing（MX）把发往 `任意前缀@你的域名` 的邮件转给 Worker，原始 .eml 落 R2 保底，再由 Durable Object 解析入库、线程归并、按规则自动归档。
- **转发**：后台可配置转发规则，按邮件头 发件人/收件人 匹配来信并转发到指定邮箱（走 Worker 内 `message.forward()`，与 CF 原生转发不同——它先经过本系统，收信与转发两不耽误）；每条规则可选择「转发并存档」或「转发后不存档」，转发失败自动回退存档保底。目标地址须为 Cloudflare 邮箱路由里已验证的 Destination。
- **后台**：浏览器登录后查看邮件列表 / 详情 / 会话视图，下载附件与原始 .eml；邮件正文用 sandboxed iframe + CSP 安全渲染，外链图片默认不加载（防追踪像素与 XSS）。
- **发信**：后台撰写或回复，Durable Object 编排通过激活的 Provider 发出；outbox 状态机记录 发送中 / 已送出 / 失败，失败按指数退避自动重试。
- **可插拔发送层**：Provider 是接口，Resend 只是第一个实现；后台可新增、测试、切换通道，零前端改动。
- **自持**：发出的内容 100% 存自己库里；切换服务商不影响历史追溯。

## 技术要点

- 单 Worker、代码模块化（`src/` 下 ingest / api / do / providers / mime / shared 分层），Wrangler 原生打包，无额外构建配置。
- 前端 `public/` 为原生 HTML/CSS/JS，无构建步骤。
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
npx wrangler secret put CONFIG_MASTER_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_PASSWORD         # 后台登录密码（明文，填什么登录就用什么）
```

随后在 Cloudflare Email Routing 中配置路由规则：**必须**将 **Catch-all address (捕获所有地址)** 指向本 Worker（推荐，可接收任意前缀）；或者在 **Custom addresses (自定义地址)** 中为你需要的特定前缀单独配置指向本 Worker。未配置路由规则，邮件将在 Cloudflare 边缘被直接退回（`550 5.1.1 Address does not exist`）。

最后，在后台「发送通道」录入 Resend API key → 测试 → 激活。

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

注册 Resend、DNS/SPF 合并、逐步部署、部署后配置变量的顺序、接通收信、激活发信、验证清单与常见问题，全部在 **[src/readme.md](src/readme.md)**。设计原文见 [mail-relay-方案文档-v3.md](mail-relay-方案文档-v3.md)。
