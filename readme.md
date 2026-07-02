# mail-relay

个人域名邮箱系统：单个 Cloudflare Worker（代码模块化）自建收信存储与后台，发送层抽象为可插拔 Provider（当前实现 Resend）。数据自持于 Durable Object SQLite + R2，无需 D1。

设计详见 [mail-relay-方案文档-v3.md](./mail-relay-方案文档-v3.md)。

## 架构一览

- **ingest**（email handler）：SMTP 会话内 precheck + raw 落 R2 保底 + 通知 DO，不解析 MIME、不写库。
- **api**（fetch handler）：鉴权、HTTP 适配、静态资源；业务全部 RPC 委托给 DO。
- **core**（`MailboxDO`）：唯一数据所有者，负责解析入库、线程归并、发送编排、配额、outbox 重试（alarm）、Provider 加解密。

代码结构见 `src/`（`ingest/`、`api/`、`do/`、`providers/`、`mime/`、`shared/`）与前端 `public/`。

## 本地开发

```bash
npm install
cp .dev.vars .dev.vars.local   # 按需修改；.dev.vars 已含可用于本地的默认值
npm run dev                     # wrangler dev（本地 miniflare，模拟 DO/R2）
```

- 默认口令为 `test-password`（对应 `.dev.vars` 里的 `ADMIN_PASSWORD_HASH`）。
- 生成自定义口令哈希：`printf '你的口令' | shasum -a 256`。

## 校验

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest（@cloudflare/vitest-pool-workers 本地集成测试）
```

测试覆盖：MIME 解析、收信入库/幂等去重/线程归并/正文外置/兜底、发信编排/配额/outbox 状态机/alarm 重试、Provider 加解密与错误分类、登录锁定、分页规范。外部 Resend 调用用 fetch mock 拦截。

## 部署

1. 注入三个 secret：
   ```bash
   wrangler secret put CONFIG_MASTER_KEY     # AES-GCM 加密 Provider 配置的主密钥
   wrangler secret put SESSION_SECRET        # HMAC session cookie 签名
   wrangler secret put ADMIN_PASSWORD_HASH   # 登录口令的 SHA-256(hex)
   ```
2. 创建 R2 bucket（名称与 `wrangler.toml` 一致）：`wrangler r2 bucket create mail-relay`
3. `npm run deploy`（一次部署含 handler + DO + 静态资源）
4. Cloudflare Email Routing：Catch-all → Send to a Worker → 选本 Worker
5. 打开后台 → 发送通道 → 新增 Resend（填 API key）→ 测试连接 → 激活
6. **SPF 合并（重要）**：一个域只允许一条 SPF TXT，需把 Email Routing 与 Resend 的 include 合并为一条，如
   `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`（include 值以 Resend dashboard 为准）。

> 注意：`compatibility_date` 当前设为 `2026-06-30` 以匹配本地 workerd 版本；升级 wrangler 后可同步调整。

## 关键约束

- DO SQLite 只存索引与小正文；.eml、附件、超阈值 HTML 正文（>256KB）一律入 R2。
- 所有列表接口强制分页：`page`（默认 1）、`pageSize`（默认 20，硬上限 100）。
- 邮件正文在前端用 sandboxed `<iframe>`（无 `allow-scripts`）+ CSP 渲染，外链图片默认不加载。
