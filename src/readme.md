# mail-relay 开发与部署详解

个人域名邮箱系统：单个 Cloudflare Worker（代码模块化）自建收信存储与后台，发送层抽象为可插拔 Provider（当前实现 Resend）。数据自持于 Durable Object SQLite + R2，无需 D1。

本文档面向"从零把它跑起来并上线"的完整流程。

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
- **转发**：email handler 内按后台配置的转发规则（邮件头 发件人/收件人 匹配）调用 `message.forward()` 转发到指定邮箱——邮件先经过本系统，「收信入库」与「转发」并行完成，而非 CF 原生转发那样绕过 Worker。每条规则可选「转发并存档 / 转发后不存档」，转发失败回退存档保底。
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
| ingest | `src/ingest/handler.ts` | SMTP 会话内 precheck（拒收/转发决策）+ 命中即 `message.forward` + raw 落 R2 保底 + 通知 DO；不解析、不写库 |
| api | `src/api/*` | 鉴权、HTTP 适配、静态资源；业务全部 RPC 委托给 DO |
| core | `src/do/mailbox.ts` 等 | 唯一数据所有者 + 全部领域逻辑 + 发送编排 |

```
src/
├─ index.ts               唯一入口：导出 { email, fetch } 与 MailboxDO
├─ ingest/handler.ts      email handler
├─ api/
│  ├─ router.ts           路由分发 + 鉴权门禁；/r2sign 独立签名校验
│  ├─ auth.ts             登录、首次引导设密码、HMAC session、暴力破解转发
│  ├─ mails.ts            列表/详情/线程/附件/.eml；已读·移动·删除·重试
│  ├─ send.ts             POST /api/send
│  ├─ upload.ts           POST /api/upload：撰写页附件上传到 R2 pending 区
│  ├─ settings.ts         设置读写 + 修改管理密码
│  ├─ contacts.ts         通讯录管理端点
│  ├─ providers.ts        Provider 管理端点
│  ├─ rules.ts            收信规则管理
│  └─ forward-rules.ts    转发规则管理
├─ do/
│  ├─ mailbox.ts          MailboxDO：RPC 方法门面（含密码/设置/邮件操作/通讯录）
│  ├─ schema.ts           建表 SQL + schema_version 增量迁移（v2 forward_rules，v3 config，v4 contacts）
│  ├─ config.ts           config 表读写 + 带默认值的整数配置读取
│  ├─ contacts.ts         通讯录读写、地址解析、发送成功自动入库
│  ├─ ingest.ts           解析入库、线程归并、规则归档、precheck 转发匹配
│  ├─ send.ts             发送编排、配额、outbox、附件落库、alarm 重试、手动重试
│  └─ crypto.ts           Provider 配置 AES-GCM 加解密
├─ providers/
│  ├─ types.ts            MailProvider 接口、OutgoingMail、ProviderError
│  ├─ registry.ts         type → ProviderDef 注册表
│  └─ resend.ts           Resend 实现
├─ mime/parse.ts          postal-mime 封装：解析、地址规范化、snippet
└─ shared/
   ├─ types.ts            Env、Mail、RPC DTO、分页/设置类型
   ├─ ulid.ts             无依赖 ULID
   ├─ password.ts         管理密码 PBKDF2-SHA256 哈希与校验
   ├─ http.ts             JSON 响应、分页解析/组装
   └─ sign.ts             HMAC：session token 与 /r2sign 附件令牌
```

前端在仓库根 `public/`（原生 HTML/CSS/JS，无构建）：`index.html`、`style.css`、`app.js`、`mail-frame.js`（正文安全渲染）、`ui.js`（toast/confirm/alert/prompt 组件）。撰写为独立页面 + `contenteditable` 富文本 + 收件人通讯录联想；提示/确认统一走 `ui.js`，不用浏览器原生弹窗。移动端通过 `style.css` 的 `@media (max-width:768px)` 适配（顶部汉堡 + 抽屉侧栏），桌面端不变。

**配置存储**：业务配置集中在 DO 的 `config` 表（`config_name`/`config_value`），键含 `admin_password_hash`、`primary_domain`、`login_max_fails`、`login_lock_seconds`、`daily_send_limit`、`body_inline_max`。仅 `CONFIG_MASTER_KEY`/`SESSION_SECRET` 两个加密/签名根密钥保留为 secret（存进被它们保护的库没有意义）。

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
   - **关于 SPF 配置与合并（最容易踩的坑）**：
     - **强烈推荐方案（免合并）**：在 Resend 添加域名时，使用**子域名**（例如 `send.yourdomain.com`）专门用于发信。这样它的 SPF 记录与你主域名（用于收信）的 SPF 记录物理隔离，互不干扰，直接按 Resend 提示添加即可。
     - **同一域名收发方案（必须合并）**：如果你非要在同一个主域名上既用 Cloudflare 收信又用 Resend 发信，由于一个域只允许一条 SPF `TXT` 记录，Cloudflare 自动写入的 SPF 和 Resend 要求的 `include` 必须**手动合并成一条**，形如：
       ```
       v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
       ```
       （`include` 的具体值以 Resend dashboard 显示为准。）不合并或添加多条 SPF 记录，外发邮件基本会进垃圾箱。
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
- 不再有 `[vars]`：每日发送上限、正文外置阈值、登录锁定阈值/时长等业务参数已迁入 DO `config` 表，在后台「设置」页调整。

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
```

- 只需两个根密钥；**管理密码不在这里配置**，首次打开后台会引导你在页面上设置（PBKDF2 哈希存入 config 表）。
- 想重置本地状态（含已设密码、邮件、附件），删除 `.wrangler/state/v3/do` 与 `.wrangler/state/v3/r2` 后重启 `wrangler dev` 即可，下次访问会重新走首次引导。

启动后浏览器打开 `http://127.0.0.1:8787`（或 wrangler 输出的端口），首次访问设置管理密码，随后进「设置」页填主域名。本地 Resend 发信会真的调用 Resend API（如果你在后台填了真实 key）；只想跑通界面可以不激活任何通道。

---

## 7. 测试

```bash
npm run typecheck     # tsc --noEmit，全量类型检查
npm test              # vitest run，@cloudflare/vitest-pool-workers 本地集成测试
```

测试在本地 workerd 里模拟 Durable Object / R2 / SQLite，覆盖：

- MIME 解析：地址规范化、snippet、References 抽取。
- 收信：precheck 放行/拒收、幂等去重（重复 message-id）、线程归并（In-Reply-To）、正文超阈值外置 R2、解析失败兜底、规则自动归档。
- 转发规则：precheck 邮件头 发件人/收件人 复合匹配、目标去重、keepOriginal 并集、停用规则不参与。
- 发信：每日配额、回复继承 threading 头、outbox 状态机（成功/可重试/终态失败）、alarm 指数退避与超限转 failed。
- 附件：pending 上传后发送落库并转正式区、pending 清除、provider 收到内联；alarm 重试与手动 `retrySend` 均保留附件（修复此前重试丢附件）。
- 邮件操作：标记已读/未读、移动文件夹、彻底删除并清理 R2（含表行）。
- 配置与密码：首次 setup、重复 setup 拒绝、改密码校验旧密码、settings 默认值与更新。
- 通讯录：地址解析（显示名/纯址、小写归一）、邮箱判重 upsert、发送成功自动入库不覆盖已有名字、getMail 的 from_saved、删除。
- Provider：AES-GCM 加解密往返、激活唯一性、Resend 429/5xx→可重试、4xx→终态、更新时 secret 留空不覆盖。
- 鉴权：首次引导设密码后登录签发 cookie、连续失败锁定、未登录 401。
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

**不需要在灌完 secret 后再 deploy 一次。** `wrangler secret put` 本身就会立即用"当前已部署的代码 + 新 secret"重新发布一个版本——它是即时生效的，不是等下次 deploy 才应用。两个 secret 灌完，最新版本就已带着它们在运行。（重复 deploy 也完全安全、不会重跑 DO migration，只是多余。）

需要注入的两个 secret（不写进 `wrangler.toml`，不进代码）：

| Secret | 用途 |
|---|---|
| `CONFIG_MASTER_KEY` | 加密 Provider 配置（如 Resend API key）后落 SQLite 的 AES-GCM 主密钥。这是唯一需要"出厂配置"的加密根。 |
| `SESSION_SECRET` | 后台登录 session cookie 的 HMAC 签名密钥，同时用于 `/r2sign` 附件令牌。 |

```bash
# 部署之后注入（会提示粘贴值）；每条 put 都会立即重新发布并生效
npx wrangler secret put CONFIG_MASTER_KEY     # 建议用 openssl rand -hex 32 生成
npx wrangler secret put SESSION_SECRET        # 建议用 openssl rand -hex 32 生成
```

- `CONFIG_MASTER_KEY` / `SESSION_SECRET` 请用足够长的随机串，例如 `openssl rand -hex 32` 生成。
- **`CONFIG_MASTER_KEY` 一旦用于加密线上 Provider 配置就不要更换**，否则已存的配置无法解密，需要在后台重新录入 key。
- **管理密码不再是 secret**：首次访问后台会引导设置，PBKDF2 哈希存入 DO `config` 表；之后在「设置」页修改。其余业务参数（每日发送上限、正文外置阈值、登录防爆破、主域）也都在「设置」页调整，即改即生效，无需 `deploy`。

> Resend 的 API key **不在这里配置**。它是在后台 UI 里录入的，会用 `CONFIG_MASTER_KEY` 加密后存进 SQLite——这样"后台可配置、可切换 Provider"才成立。

---

## 10. 接通收信与激活发信通道

Worker 部署且 secret 注入后：

1. **设置管理密码**：浏览器打开 Worker 域名（`https://mail-relay.<你的子域>.workers.dev` 或你绑定的自定义域）→ 首次访问进入「初始化」页 → 设置后台管理密码（至少 6 位，PBKDF2 哈希入库）。
2. **填写主域**：登录后进「设置」页填入**主域名**（如 `yourdomain.com`）。此后「写邮件」的默认发件人为 `admin@主域`；回复邮件仍按「谁收谁发」自动带出原收件地址。此页还可调登录防爆破、每日发送配额、正文外置阈值，以及修改管理密码。
3. **接通收信**：Cloudflare 控制台 → Email → Email Routing → **Catch-all address → Send to a Worker → 选择本 Worker**。此后发往 `任意前缀@你的域名` 的邮件都会进本系统。
4. **配置发信通道**：左侧「发送通道」→ **新增通道** → 选择 Resend → 粘贴第 4 步创建的 Resend API key（可选填发件人显示名）→ 保存。
5. **测试连接**：在通道列表点「测试」，会调用 Resend 校验 key；成功后点「激活」。同一时刻只有一个激活通道，发信即走它。

### 配置转发规则（可选）

想让某些来信在入库的同时自动转发到你的常用邮箱（如 Gmail），在后台「转发规则」里新增规则即可。

- **匹配方式**：按邮件头 `From` / `To` 做包含子串、大小写不敏感匹配。「发件人含」「收件人含」至少填一项；两项都填即「来自 A 且发往 B」才命中。规则匹配用的是邮件头地址（即邮件客户端里看到的发件人），不消费邮件流、不做完整解析，SMTP 会话内毫秒级决策。
- **原件处理**：每条规则可选「转发并存档」（默认，转发之外仍入库）或「转发后不存档」（命中即转走、本系统不留档）。选「不存档」时若转发失败会**自动回退存档**，保证邮件不丢。
- **前置条件（重要）——验证转发目标 Destination**：转发走 Worker 内的 `message.forward()`，Cloudflare 要求转发目标必须是**已验证的 Destination address**，否则转发会失败（此时按上面的回退逻辑仍会存档）。验证步骤（一次性，每个新目标邮箱做一次）：

  1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/) → 选中你的域名。
  2. 左侧菜单 **Email（电子邮件）→ Email Routing（电子邮件路由）**。
  3. 打开 **Destination addresses（目标地址）** 标签页（部分账号在 **Settings/设置** 子页下）。
  4. 点 **Add destination address（添加目标地址）** → 填入要转发到的邮箱（如 `you@gmail.com`）→ 确认。
  5. Cloudflare 会给该邮箱发一封验证邮件，**打开邮箱点邮件里的验证链接**（链接有时效，过期就在上面列表点重发）。
  6. 回到 **Destination addresses** 列表，该地址状态变为 **Verified（已验证）** 即可。之后在本系统「转发规则」的「转发到」里填这个地址才会真正生效。
- **拒收优先级**：收信规则里的「拒收」优先于转发——命中拒收的信直接在 SMTP 会话拒绝，不会转发也不入库。
- **环路保护**：本系统转发出去的邮件带 `X-Forwarded-By: mail-relay` 头；若这类邮件又流回本 Worker，则只入库、不再二次转发。

---

## 11. 验证清单

- 首次访问后台 → 进入「初始化」页设密码；重启/重装后未设密码时应始终先走此页。
- 外部往 `任意前缀@你的域名` 发一封信 → 后台「收件箱」可见；附件与原始 .eml 可下载；同一封信重投不产生重复记录。
- 对这封信标记未读 / 移入垃圾邮件 / 删除（进废纸篓，再删则彻底清理）→ 列表与文件夹状态随之变化。
- 在后台对这封信「回复」→ 撰写页自动引用原文、发件人为原收件地址 → 对方端归入同一会话（threading 生效）。
- 「写邮件」上传附件并发送 → 「已发送」显示状态徽章；对方收到带附件的邮件；邮件详情能再次下载该附件。
- 「设置」页填主域后，新建「写邮件」的发件人默认 `admin@主域`。
- 发送成功后收件人自动进「通讯录」；写邮件时收件人输入触发联想下拉；收信详情点「＋ 存入通讯录」后按钮消失、再开不再出现。
- 收件箱点「🔄 检查新邮件」重新拉取列表。
- 手机浏览器（或 DevTools 移动视口）打开：顶部汉堡展开抽屉侧栏，列表/表格/撰写页/弹窗不错位。
- 故意把 Resend key 填错 → 「测试」报错；发送失败时「已发送」列表显示「发送失败」并可点「重试」。
- 连续输错登录口令达阈值 → 被锁定（返回 429）。

---

## 12. 常见问题

- **外发进垃圾箱**：多半是 SPF 没合并成一条，或 DKIM 记录没生效。回到第 4 步核对 Cloudflare DNS。
- **`wrangler dev` 或 `npm test` 报 `vm._setUnsafeEval is not a function`**：`@cloudflare/vitest-pool-workers` 与 `wrangler`/`workerd`/`vitest` 版本不匹配。保持本仓库锁定的版本组合，或整体升级到互相兼容的一套。
- **部署报 compatibility date 太新**：把 `wrangler.toml` 的 `compatibility_date` 调到不晚于当前 workerd 版本对应日期。
- **改登录密码**：登录后进「设置」页 → 「修改管理密码」，输入当前密码与新密码即可（即时生效，PBKDF2 哈希入库）。
- **忘了密码**：密码哈希存在 DO `config` 表，无法反解。用 `wrangler d1`/DO 无直接删表 CLI，最简单是清掉该 config 键让系统回到首次引导——可临时加一个受保护的管理脚本删除 `config` 表中 `admin_password_hash` 行，或在开发期删除本地 `.wrangler/state` 重置。生产环境务必保管好密码。
- **换发信服务商**：后台「发送通道」新增新类型配置 → 激活即可，历史数据不受影响（outbox 记录了每封信当时用哪家发的）。新增一个"类型"（如 SES）需要在 `src/providers/` 加一个实现文件并 `deploy` 一次。
- **存储额度**：DO SQLite 免费档 1 GB/对象；写满后 INSERT/UPDATE 报 `SQLITE_FULL`，读与删除仍可用。大对象都在 R2（免费 10 GB），正文外置规则兜底。
