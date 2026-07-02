# mail-relay 开发与部署详解

个人域名邮箱系统：单个 Cloudflare Worker（代码模块化）自建收信存储与后台，发送层抽象为可插拔 Provider（当前实现 Resend）。数据自持于 Durable Object SQLite + R2，无需 D1。

设计原文见仓库根目录 [mail-relay-方案文档-v3.md](../mail-relay-方案文档-v3.md)。本文档面向"从零把它跑起来并上线"的完整流程。

---

## 目录

1. [项目是什么](#1-项目是什么)
2. [架构与代码结构](#2-架构与代码结构)
3. [环境要求](#3-环境要求)
4. [注册并配置 Resend](#4-注册并配置-resend)
5. [Cloudflare 侧前置准备](#5-cloudflare-侧前置准备)
6. [本地开发](#6-本地开发)
7. [测试](#7-测试)
8. [部署（发布）](#8-部署发布)
9. [部署后配置变量（关键顺序）](#9-部署后配置变量关键顺序)
10. [接通收信与激活发信通道](#10-接通收信与激活发信通道)
11. [验证清单](#11-验证清单)
12. [常见问题](#12-常见问题)

---

## 1. 项目是什么

用自己的域名收发邮件，数据完全自持，不依赖第三方邮箱服务的存储：

- **收信**：对方 SMTP → Cloudflare Email Routing（MX）→ 本 Worker 的 email handler → 原始 .eml 落 R2 → Durable Object 解析入库、线程归并、按规则归档。
- **看信/管理**：浏览器打开 Worker 域名 → 登录后台 → 邮件列表/详情/会话视图/附件下载/原始 .eml 下载。
- **发信**：后台撰写或回复 → Durable Object 编排 → 通过激活的 Provider（Resend）发出 → outbox 状态机记录 发送中/已送出/失败，失败按指数退避自动重试。
- **可插拔发送层**：Provider 抽象为接口，Resend 只是第一个实现；未来加 SES/Brevo 只需新增一个实现文件，后台即可新增、测试、切换，零前端改动。

关键设计取舍：

- MIME 解析放进 Durable Object（每次调用独立 30s CPU 预算），免费档也能稳解析大附件邮件；email handler 只做"读流 + 落盘 + 通知"。
- Durable Object 单实例串行执行，幂等去重、每日发送配额、outbox 状态机全部免锁免竞态。
- SQLite 只存索引与小正文；.eml、附件、超阈值 HTML 正文（>256KB）一律入 R2。
- 邮件正文在前端用 sandboxed `<iframe>`（不给 `allow-scripts`）+ CSP 渲染，外链图片默认不加载——邮件是外部输入，这是全系统最大的 XSS 面。

---

## 2. 架构与代码结构

逻辑三层，物理同一个 Worker：

| 层 | 位置 | 职责 |
|---|---|---|
| ingest | `src/ingest/handler.ts` | SMTP 会话内 precheck + raw 落 R2 保底 + 通知 DO；不解析、不写库 |
| api | `src/api/*` | 鉴权、HTTP 适配、静态资源；业务全部 RPC 委托给 DO |
| core | `src/do/mailbox.ts` 等 | 唯一数据所有者 + 全部领域逻辑 + 发送编排 |

```
src/
├─ index.ts               唯一入口：导出 { email, fetch } 与 MailboxDO
├─ ingest/handler.ts      email handler
├─ api/
│  ├─ router.ts           路由分发 + 鉴权门禁；/r2sign 独立签名校验
│  ├─ auth.ts             登录、HMAC session、暴力破解转发
│  ├─ mails.ts            列表/详情/线程/附件/.eml 下载
│  ├─ send.ts             POST /api/send
│  ├─ providers.ts        Provider 管理端点
│  └─ rules.ts            收信规则管理
├─ do/
│  ├─ mailbox.ts          MailboxDO：RPC 方法门面
│  ├─ schema.ts           建表 SQL + schema_version 增量迁移
│  ├─ ingest.ts           解析入库、线程归并、规则归档
│  ├─ send.ts             发送编排、配额、outbox、alarm 重试
│  └─ crypto.ts           Provider 配置 AES-GCM 加解密
├─ providers/
│  ├─ types.ts            MailProvider 接口、OutgoingMail、ProviderError
│  ├─ registry.ts         type → ProviderDef 注册表
│  └─ resend.ts           Resend 实现
├─ mime/parse.ts          postal-mime 封装：解析、地址规范化、snippet
└─ shared/
   ├─ types.ts            Env、Mail、RPC DTO、分页类型
   ├─ ulid.ts             无依赖 ULID
   ├─ http.ts             JSON 响应、分页解析/组装
   └─ sign.ts             HMAC：session token 与 /r2sign 附件令牌
```

前端在仓库根 `public/`（原生 HTML/CSS/JS，无构建）：`index.html`、`style.css`、`app.js`、`mail-frame.js`（正文安全渲染）。

依赖规则：`do/` 依赖 `providers/`、`mime/`、`shared/`，不依赖 `api/`、`ingest/`；`api/`、`ingest/` 只认 DO 的 RPC 接口类型，不碰 DO 内部实现。

---

## 3. 环境要求

- Node.js（建议 20+；本仓库在 Node 23 上验证过）。
- 一个托管在 **Cloudflare DNS** 的域名（Email Routing 需要 Cloudflare 管理该域的 DNS）。
- Cloudflare 账号（Workers + Durable Objects + R2；免费档即可）。
- Resend 账号（发信）。
- 安装依赖：

  ```bash
  npm install
  ```

  依赖 `postal-mime`（解析）；devDependencies 含 `wrangler`、`typescript`、`vitest`、`@cloudflare/vitest-pool-workers`、`@cloudflare/workers-types`。

> 版本说明：`@cloudflare/vitest-pool-workers` 与 `wrangler`/`workerd`/`vitest` 必须版本匹配，否则测试会报 `vm._setUnsafeEval is not a function`。本仓库锁定 pool-workers 0.17 + vitest 4 + wrangler 4.106 这一组。`wrangler.toml` 的 `compatibility_date` 需 ≤ 本地 workerd 构建日期，当前设为 `2026-06-30`。

---

## 4. 注册并配置 Resend

Resend 负责实际把邮件投递出去（提供 DKIM 签名与投递基础设施）。

1. 打开 <https://resend.com/signup> 注册账号。
2. 进入 **Domains → Add Domain**，填写你的域名（与收信用的同一个域）。
3. Resend 会给出一组 DNS 记录（DKIM 的若干 `CNAME`/`TXT`，以及 SPF 所需的 `include`）。到 Cloudflare DNS 逐条添加。
   - **SPF 合并（最容易踩的坑）**：一个域只允许一条 SPF `TXT` 记录。Cloudflare Email Routing 会自动写入一条 SPF，Resend 又要求它的 `include`，两者必须**手动合并成一条**，形如：

     ```
     v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
     ```

     （`include` 的具体值以 Resend dashboard 显示为准。）不合并，外发邮件基本会进垃圾箱。
4. 等域名在 Resend 里变为 **Verified**（DNS 生效可能需要几分钟到几十分钟）。
5. 进入 **API Keys → Create API Key**，权限选 **Sending access**（只用于发信）。复制这把 key——它稍后**在本项目后台里录入**，不写进任何配置文件。

> Resend 免费档限制：3000 封/月、100 封/天、1 个域名、5 请求/秒、退信率需 <4%。本项目用每日配额计数与收件人格式校验来配合这些限制。

---

## 5. Cloudflare 侧前置准备

1. 确认域名的 DNS 托管在 Cloudflare。
2. 在 Cloudflare 控制台开启 **Email → Email Routing**。Catch-all 的目标稍后设为本 Worker（需要 Worker 先部署存在，见第 10 步）。
3. 创建 R2 bucket（名字要与 `wrangler.toml` 里的 `bucket_name` 一致，默认 `mail-relay`）：

   ```bash
   npx wrangler r2 bucket create mail-relay
   ```

`wrangler.toml` 已经声明好这些绑定，无需手改：

- `[assets]` 静态资源目录 `./public`，`run_worker_first` 让 `/api/*` 与 `/r2sign/*` 先进 Worker，其余走 SPA 兜底。
- `[[r2_buckets]]` 绑定名 `MAIL_R2`。
- `[[durable_objects.bindings]]` 绑定名 `MAILBOX` → 类 `MailboxDO`。
- `[[migrations]]` 声明 `MailboxDO` 为 SQLite-backed Durable Object。
- `[vars]` 里是非机密的可调参数：每日发送上限、正文外置阈值、登录锁定阈值/时长。

---

## 6. 本地开发

```bash
npm install
npm run dev            # = wrangler dev，本地用 miniflare 模拟 DO/R2/SQLite
```

本地机密通过仓库根的 `.dev.vars` 提供（该文件已被 `.gitignore` 忽略，不要提交）：

```
CONFIG_MASTER_KEY = "dev-master-key-please-change"
SESSION_SECRET    = "dev-session-secret-please-change"
ADMIN_PASSWORD    = "test-password"
```

- `ADMIN_PASSWORD` 就是后台登录密码本身：填什么，登录就用什么（无需算哈希）。
- 仓库自带的 `.dev.vars` 默认密码是 `test-password`，想改直接改这里的值。

启动后浏览器打开 `http://127.0.0.1:8787`（或 wrangler 输出的端口），用口令登录即可操作后台。本地 Resend 发信会真的调用 Resend API（如果你在后台填了真实 key）；只想跑通界面可以不激活任何通道。

---

## 7. 测试

```bash
npm run typecheck     # tsc --noEmit，全量类型检查
npm test              # vitest run，@cloudflare/vitest-pool-workers 本地集成测试
```

测试在本地 workerd 里模拟 Durable Object / R2 / SQLite，覆盖：

- MIME 解析：地址规范化、snippet、References 抽取。
- 收信：precheck 放行/拒收、幂等去重（重复 message-id）、线程归并（In-Reply-To）、正文超阈值外置 R2、解析失败兜底、规则自动归档。
- 发信：每日配额、回复继承 threading 头、outbox 状态机（成功/可重试/终态失败）、alarm 指数退避与超限转 failed。
- Provider：AES-GCM 加解密往返、激活唯一性、Resend 429/5xx→可重试、4xx→终态、更新时 secret 留空不覆盖。
- 鉴权：登录签发 cookie、连续失败锁定、未登录 401。
- 分页：默认值、硬上限 100、返回结构、深分页页数正确。

外部 Resend 网络调用在测试里用 `vi.stubGlobal('fetch', ...)` 拦截，不产生真实请求。

---

## 8. 部署（发布）

```bash
npx wrangler login        # 首次：登录 Cloudflare 账号
npx wrangler deploy       # 一次部署：handler + Durable Object + 静态资源
```

`wrangler deploy` 会把整个 Worker（含前端静态资源、DO 类、迁移）打包上传。首次部署即会创建 Durable Object 命名空间并应用 `[[migrations]]`。

> 想先验证能否正常打包而不真的上线：`npx wrangler deploy --dry-run`。

---

## 9. 部署后配置变量（关键顺序）

**必须先 `wrangler deploy` 让 Worker 在云端存在，之后再注入 secrets。** 原因：`wrangler secret put` 要求目标 Worker 已经存在，否则会报错（或提示创建一个没有代码的空 Worker）。

**不需要在灌完 secret 后再 deploy 一次。** `wrangler secret put` 本身就会立即用"当前已部署的代码 + 新 secret"重新发布一个版本——它是即时生效的，不是等下次 deploy 才应用。三个 secret 灌完，最新版本就已带着它们在运行。（重复 deploy 也完全安全、不会重跑 DO migration，只是多余。）

需要注入的三个 secret（不写进 `wrangler.toml`，不进代码）：

| Secret | 用途 |
|---|---|
| `CONFIG_MASTER_KEY` | 加密 Provider 配置（如 Resend API key）后落 SQLite 的 AES-GCM 主密钥。这是唯一需要"出厂配置"的加密根。 |
| `SESSION_SECRET` | 后台登录 session cookie 的 HMAC 签名密钥，同时用于 `/r2sign` 附件令牌。 |
| `ADMIN_PASSWORD` | 后台登录密码（明文）。填什么，登录就用什么，无需算哈希。 |

```bash
# 部署之后注入（会提示粘贴值）；每条 put 都会立即重新发布并生效
npx wrangler secret put CONFIG_MASTER_KEY     # 建议用 openssl rand -hex 32 生成
npx wrangler secret put SESSION_SECRET        # 建议用 openssl rand -hex 32 生成
npx wrangler secret put ADMIN_PASSWORD        # 直接输入你想要的登录密码
```

- `CONFIG_MASTER_KEY` / `SESSION_SECRET` 请用足够长的随机串，例如 `openssl rand -hex 32` 生成。
- **`CONFIG_MASTER_KEY` 一旦用于加密线上 Provider 配置就不要更换**，否则已存的配置无法解密，需要在后台重新录入 key。
- `[vars]` 里的非机密参数（每日发送上限等）直接改 `wrangler.toml` 后 `deploy` 即可，无需走 secret。

> Resend 的 API key **不在这里配置**。它是在后台 UI 里录入的，会用 `CONFIG_MASTER_KEY` 加密后存进 SQLite——这样"后台可配置、可切换 Provider"才成立。

---

## 10. 接通收信与激活发信通道

Worker 部署且 secret 注入后：

1. **接通收信**：Cloudflare 控制台 → Email → Email Routing → **Catch-all address → Send to a Worker → 选择本 Worker**。此后发往 `任意前缀@你的域名` 的邮件都会进本系统。
2. **配置发信通道**：浏览器打开 Worker 域名（`https://mail-relay.<你的子域>.workers.dev` 或你绑定的自定义域）→ 用口令登录 → 左侧「发送通道」→ **新增通道** → 选择 Resend → 粘贴第 4 步创建的 Resend API key（可选填发件人显示名）→ 保存。
3. **测试连接**：在通道列表点「测试」，会调用 Resend 校验 key；成功后点「激活」。同一时刻只有一个激活通道，发信即走它。

---

## 11. 验证清单

- 外部往 `任意前缀@你的域名` 发一封信 → 后台「收件箱」可见；附件与原始 .eml 可下载；同一封信重投不产生重复记录。
- 在后台对这封信「回复」→ 对方端归入同一会话（threading 生效）。
- 后台「写邮件」主动新发一封到你的 Gmail → 在 Gmail「显示原始邮件」里 SPF/DKIM 均 `pass`。
- 故意把 Resend key 填错 → 「测试」报错；发送失败时 outbox 显示失败/重试状态。
- 连续输错登录口令达阈值 → 被锁定（返回 429）。

---

## 12. 常见问题

- **外发进垃圾箱**：多半是 SPF 没合并成一条，或 DKIM 记录没生效。回到第 4 步核对 Cloudflare DNS。
- **`wrangler dev` 或 `npm test` 报 `vm._setUnsafeEval is not a function`**：`@cloudflare/vitest-pool-workers` 与 `wrangler`/`workerd`/`vitest` 版本不匹配。保持本仓库锁定的版本组合，或整体升级到互相兼容的一套。
- **部署报 compatibility date 太新**：把 `wrangler.toml` 的 `compatibility_date` 调到不晚于当前 workerd 版本对应日期。
- **改登录密码 / 忘了密码**：`wrangler secret put ADMIN_PASSWORD` 直接输入新密码即可（即时生效，无需再 deploy）。
- **换发信服务商**：后台「发送通道」新增新类型配置 → 激活即可，历史数据不受影响（outbox 记录了每封信当时用哪家发的）。新增一个"类型"（如 SES）需要在 `src/providers/` 加一个实现文件并 `deploy` 一次。
- **存储额度**：DO SQLite 免费档 1 GB/对象；写满后 INSERT/UPDATE 报 `SQLITE_FULL`，读与删除仍可用。大对象都在 R2（免费 10 GB），正文外置规则兜底。
