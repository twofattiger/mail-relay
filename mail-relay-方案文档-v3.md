# mail-relay 方案文档 v3

个人域名邮箱系统:单 Cloudflare Worker(代码模块化组织)自建收信存储与后台,发送层抽象为可插拔 Provider(当前实现 Resend)。数据自持于 Durable Object SQLite + R2,无需创建 D1。

v3 说明:部署形态为**单 Worker**(一次 deploy),代码按模块拆分为多文件——Wrangler 原生支持 ESM 多文件,deploy 时自动打包,无需任何额外构建配置。

---

## 1. 总体架构

```
                    ┌──────────────────────────────────────────────┐
                    │            mail-relay Worker(单部署)         │
                    │                                              │
收信:对方 SMTP      │  email handler(src/ingest/)                 │
 → MX(Email Routing)→ │   1. DO.precheck(信封) → setReject 或放行  │
                    │   2. raw 落 R2(返回 250 前,保底)           │
                    │   3. waitUntil → DO.ingest(r2Key, 信封)      │
                    │                                              │
浏览器 → 后台 UI →  │  fetch handler(src/api/)                    │
                    │   静态资源 + REST API + 鉴权                  │
                    │   业务全部 RPC 委托给 DO                      │
                    │                                              │
                    │  MailboxDO(src/do/,同脚本内的 DO 类)       │
                    │   SQLite:全部结构化数据                      │
                    │   领域逻辑:解析入库/线程归并/发送编排/       │
                    │   配额计数/outbox 重试(alarm)               │
                    │   Provider 注册表在此加载执行                 │
                    └──────────────────┬───────────────────────────┘
                                       │
              R2(原始 .eml / 附件 / 超大正文)   外发:激活 Provider → Resend / 未来 SES…
```

### 1.1 运行时分层(逻辑分层,物理同一 Worker)

| 层 | 位置 | 职责 | 明确不做 |
|---|---|---|---|
| **ingest** | email handler | SMTP 会话内当场决策 + raw 落盘 + 通知 DO | 不解析 MIME、不写库 |
| **api** | fetch handler | 鉴权、HTTP 协议适配、前端静态资源 | 不直接摸数据库,一切经 DO RPC |
| **core** | MailboxDO | 唯一数据所有者 + 全部领域逻辑 + 发送编排 | 不感知 HTTP/SMTP 细节 |

关键设计收益(与部署形态无关,来自 DO 这一层):

- **CPU 预算迁移**:email handler 免费档仅 10ms CPU;DO 每次调用有独立的 30s CPU 预算。MIME 解析放进 `DO.ingest`,大附件邮件免费档也能稳解析
- **天然串行化**:DO 单线程,幂等去重、每日发送配额计数、outbox 状态机全部免锁免竞态
- **收口**:handler 层不含业务规则,所有状态变更走 DO 的领域方法,入口(SMTP/HTTP)只是协议适配器

### 1.2 DO 实例策略

**单实例**:`env.MAILBOX.getByName("main")`。个人邮箱是单租户全局数据;单 DO 软上限 1000 req/s 远超需求。不按地址分片(跨片列表/搜索会把简单问题复杂化)。

### 1.3 存储额度(设计约束)

- DO SQLite:免费计划 **1 GB/对象、账户共 5 GB**;付费计划 10 GB/对象。免费计划只能创建 SQLite-backed DO(正好)
- 写满后 INSERT/UPDATE 报 `SQLITE_FULL`,读与 DELETE 仍可用
- 因此 SQLite 只存**索引与小正文**,所有大对象(.eml、附件、超阈值 HTML 正文)一律 R2(10 GB 免费,blob 的正确归宿)。1 GB 索引对个人邮箱是数年级余量,§4.3 正文外置规则兜底

---

## 2. 代码组织(单 Worker 多模块)

```
mail-relay/
├─ wrangler.toml             一份配置:email 触发 + DO class + R2 + assets
├─ package.json              依赖:postal-mime(+ 前端构建依赖,如有)
├─ public/                   前端静态资源(Workers static assets)
└─ src/
   ├─ index.ts               ★ 唯一入口:导出 { email, fetch } 与 MailboxDO 类
   │                           内部只做分发,不含业务
   ├─ ingest/
   │  └─ handler.ts          email handler 实现(§6.1)
   ├─ api/
   │  ├─ router.ts           路由表 → 各 handler
   │  ├─ auth.ts             登录、HMAC session、暴力破解防护转发
   │  ├─ mails.ts            列表/详情/线程/附件下载
   │  ├─ send.ts             POST /api/send
   │  └─ providers.ts        Provider 管理端点(§5.2)
   ├─ do/
   │  ├─ mailbox.ts          MailboxDO 类:RPC 方法门面
   │  ├─ schema.ts           建表 SQL + 迁移(schema_version 增量)
   │  ├─ ingest.ts           解析入库、线程归并(领域逻辑)
   │  ├─ send.ts             发送编排、配额、outbox、alarm 重试
   │  └─ crypto.ts           Provider 配置 AES-GCM 加解密
   ├─ providers/
   │  ├─ types.ts            MailProvider 接口、OutgoingMail、SendResult、ConfigField
   │  ├─ registry.ts         type → ProviderDef 注册表
   │  └─ resend.ts           Resend 实现(未来 ses.ts、brevo.ts 并列于此)
   ├─ mime/
   │  └─ parse.ts            postal-mime 封装:解析、地址规范化、snippet 提取
   └─ shared/
      ├─ types.ts            Mail、Attachment、RPC DTO
      └─ ulid.ts 等工具
```

入口示意:

```ts
// src/index.ts —— 只有分发,没有逻辑
import { handleEmail } from "./ingest/handler";
import { handleFetch } from "./api/router";
export { MailboxDO } from "./do/mailbox";

export default {
  email: handleEmail,
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
```

依赖规则(保持可维护性的关键约束):

- `do/` 依赖 `providers/`、`mime/`、`shared/`;**不**依赖 `api/`、`ingest/`
- `api/`、`ingest/` 依赖 `shared/` 与 DO stub 类型;**不**互相依赖、不依赖 `do/` 内部实现
- `providers/` 只依赖 `shared/`,零平台绑定(便于单测)

Wrangler 对 ESM 多文件与 npm 依赖自动打包(内置 esbuild),`import` 随便写,无需 webpack/rollup 配置。

---

## 3. 前置准备与平台配置

1. 域名托管在 Cloudflare DNS;启用 Email Routing,Catch-all → Send to a Worker(本 Worker)
2. Resend 注册(https://resend.com/signup)→ Domains 添加同一域名 → 按 dashboard 写入 DKIM/SPF DNS 记录 → 建 Sending-only API key
3. **SPF 合并(坑)**:一个域只允许一条 SPF TXT,Email Routing 自动写入的与 Resend 要求的必须手动合并为一条,形如 `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all`(include 值以 Resend dashboard 为准)。不合并外发必进垃圾箱
4. 创建 R2 bucket(一个)

`wrangler.toml` 要素:

```toml
name = "mail-relay"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[assets]
directory = "./public"

[[r2_buckets]]
binding = "MAIL_R2"
bucket_name = "mail-relay"

[[durable_objects.bindings]]
name = "MAILBOX"
class_name = "MailboxDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MailboxDO"]
```

Secrets(注意:Provider 的 API key 不在此列):

| Secret | 用途 |
|---|---|
| `CONFIG_MASTER_KEY` | AES-GCM 加密 Provider 配置后落 SQLite 的主密钥 |
| `SESSION_SECRET` | HMAC session cookie 签名 |
| `ADMIN_PASSWORD_HASH` | 登录口令哈希(或首次启动写入 DO,二选一) |

Resend API key 通过后台 UI 录入 → 加密存 `providers` 表——"后台可配置、可切换 Provider"由此成立;`CONFIG_MASTER_KEY` 是唯一需要出厂配置的加密根。

---

## 4. 数据模型(MailboxDO SQLite)

### 4.1 Schema

```sql
-- 迁移:DO constructor 内 blockConcurrencyWhile,按 meta.schema_version 顺序执行增量 SQL
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version、每日发送计数等

CREATE TABLE mails (
  id             TEXT PRIMARY KEY,        -- ULID
  direction      TEXT NOT NULL,           -- 'in' | 'out'
  message_id     TEXT UNIQUE,             -- 幂等去重键;外发时自行生成 <ulid@domain>
  thread_id      TEXT NOT NULL,
  from_addr      TEXT NOT NULL,           -- 头部 From(展示)
  envelope_from  TEXT,                    -- SMTP MAIL FROM(审计/过滤)
  to_addr        TEXT NOT NULL,
  subject        TEXT,
  snippet        TEXT,                    -- 列表页摘要 ~200 字
  body_text      TEXT,                    -- 截断 64 KB
  body_html      TEXT,                    -- 超阈值则 NULL → body_r2_key
  body_r2_key    TEXT,
  raw_r2_key     TEXT,                    -- 原始 .eml(out 方向可空)
  in_reply_to    TEXT,
  refs           TEXT,
  size_bytes     INTEGER,
  is_read        INTEGER DEFAULT 0,
  folder         TEXT DEFAULT 'inbox',    -- inbox|sent|spam|trash
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_mails_thread ON mails(thread_id, created_at);
CREATE INDEX idx_mails_list   ON mails(folder, created_at DESC);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES mails(id),
  filename TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
  r2_key TEXT NOT NULL
);

-- ★ Provider 配置
CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,         -- 'resend' | 'ses' | … 对应注册表 key
  name             TEXT NOT NULL,         -- 显示名,如 "Resend 主账号"
  config_enc       TEXT NOT NULL,         -- AES-GCM(JSON) base64,密钥=CONFIG_MASTER_KEY
  is_active        INTEGER DEFAULT 0,
  last_verified_at INTEGER,
  created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX idx_provider_active ON providers(is_active) WHERE is_active = 1;

-- ★ 外发状态机(mails 存内容,outbox 存投递状态)
CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,
  mail_id         TEXT NOT NULL REFERENCES mails(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),  -- 可追溯用哪家发的
  provider_msg_id TEXT,
  status          TEXT NOT NULL,          -- queued | sent | failed
  attempt         INTEGER DEFAULT 0,
  last_error      TEXT,
  next_retry_at   INTEGER                 -- 配合 DO alarm
);

CREATE TABLE login_attempts (ip TEXT PRIMARY KEY, fail_count INTEGER, locked_until INTEGER);
CREATE TABLE rules (                      -- 收信规则:黑名单/自动归档,precheck 用
  id TEXT PRIMARY KEY, kind TEXT, pattern TEXT, action TEXT, enabled INTEGER
);
```

### 4.2 R2 Key 结构

```
raw/{yyyy}/{mm}/{mailId}.eml
att/{mailId}/{attachmentId}/{filename}
body/{mailId}.html                    仅超阈值正文
```

### 4.3 正文外置规则

`body_html` > 256 KB → 写 R2、列置 NULL、记 `body_r2_key`;详情页按需拉取。保护 1 GB SQLite 额度(营销邮件 HTML 动辄数百 KB)。全文永远可回溯 .eml。

---

## 5. Provider 抽象层(src/providers/)

### 5.1 接口

```ts
// types.ts —— 领域层只认识这些类型,不认识任何具体厂商
export interface OutgoingMail {
  from: string; to: string[]; subject: string;
  html?: string; text?: string;
  headers?: Record<string, string>;      // In-Reply-To / References / Message-ID
  attachments?: { filename: string; content?: string /*base64*/; url?: string }[];
}
export interface SendResult { providerMessageId: string; }

export interface MailProvider {
  readonly type: string;
  send(mail: OutgoingMail): Promise<SendResult>;  // 失败抛 ProviderError{retryable}
  verifyConfig(): Promise<void>;                  // 后台"测试连接"
}

// 配置元数据 → 后台动态渲染表单,新增 provider 零前端改动
export interface ConfigField {
  key: string; label: string;
  secret?: boolean;         // true → 密码框、回显打码
  required?: boolean; placeholder?: string;
}

export interface ProviderDef {
  type: string; displayName: string;
  configSchema: ConfigField[];
  create(config: Record<string, string>): MailProvider;
}
```

```ts
// registry.ts
export const registry = new Map<string, ProviderDef>([
  ["resend", resendDef],
  // ["ses", sesDef],  ← 未来在此追加一行
]);
```

```ts
// resend.ts(示意)
export const resendDef: ProviderDef = {
  type: "resend", displayName: "Resend",
  configSchema: [
    { key: "apiKey",   label: "API Key", secret: true, required: true },
    { key: "fromName", label: "发件人显示名", placeholder: "Yiyang" },
  ],
  create: (cfg) => new ResendProvider(cfg),
};
// ResendProvider.send:POST https://api.resend.com/emails
// 429/5xx → ProviderError{retryable:true};其余 4xx → retryable:false
```

设计要点:

- **配置与实例分离**:实例由 `def.create(解密后config)` 按需构造,无状态、即建即弃;DO 不缓存实例,配置更新即刻生效
- **附件双形态在接口层保留**(base64 / url):各 provider 自行映射;不支持 url 拉取的实现内部自己下载转 base64,领域层不感知
- **错误语义进契约**:`retryable` 是发送编排唯一需要理解的错误分类,决定 outbox 重试或终态 failed
- **能力差异不上收**:配额查询、送达回执等各家差异大的能力不进核心接口,未来以可选接口(如 `SupportsQuota`)扩展

### 5.2 后台 Provider 管理(api → DO RPC)

```
GET    /api/providers             列表(secret 字段打码)
GET    /api/providers/schema      registry 全量 configSchema → 渲染"新增"表单
POST   /api/providers             校验 type → AES-GCM 加密 config → 入库
PUT    /api/providers/:id         更新(secret 字段留空 = 不变更)
POST   /api/providers/:id/verify  verifyConfig() 测试连通
POST   /api/providers/:id/activate 全表置 0 → 该行置 1(DO 单线程,天然原子)
DELETE /api/providers/:id         有 outbox 引用则禁删/软删
```

加密:`CONFIG_MASTER_KEY` 派生 AES-GCM 密钥,每条配置独立随机 IV;密钥不落库,库泄露不泄密。换厂商、改 key 全在后台完成,不碰 wrangler。

---

## 6. 收信逻辑

### 6.1 email handler(src/ingest/)

```
async email(message, env, ctx):
  1. const raw = await readAll(message.raw)          // 流只能读一次,先读完
  2. const v = await stub.precheck({ envelopeFrom, to, size })   // 毫秒级 RPC 查 rules
     if (v.reject) { message.setReject(v.reason); return }
  3. await env.MAIL_R2.put(r2Key, raw)               // ★ 返回 250 前同步落盘保底
  4. ctx.waitUntil(stub.ingest({ r2Key, envelopeFrom, envelopeTo, size }))
  5. return                                          // 对方收 250,SMTP 会话结束
```

- **只传 r2Key 不传原文**:避开 RPC 载荷大小限制,且保证"即使 DO 调用失败,原始件已在 R2",可事后扫描补索引
- 步骤 3 在 waitUntil 之外:这是投递责任转移点,落盘失败则不返回 250,让对方按临时错误重投

### 6.2 MailboxDO.ingest(30s CPU 预算)

1. R2 取 raw → postal-mime 解析
2. `message_id` 查重(UNIQUE 兜底)→ 重复投递幂等返回
3. 附件循环写 R2 + attachments 表
4. 正文按 §4.3 入库或外置
5. 线程归并:In-Reply-To/References 任一命中已有记录 → 沿用其 thread_id;否则新线程(thread_id = 自身 message_id)
6. rules 匹配自动归档(spam 判定可依据 Email Routing 标注的 Authentication-Results 头)
7. (可选)通知:Telegram/ntfy 推摘要

解析失败兜底:写入 `needs_parse` 标记的最小记录(信封信息 + raw_r2_key),后台可见、.eml 可下载,不静默丢失。

---

## 7. 发信逻辑(编排在 DO)

### 7.1 主流程

```
POST /api/send { to, subject, html, replyToMailId?, attachmentIds? }
  api:鉴权 → stub.send(dto)

MailboxDO.send:
  1. 每日配额检查(meta 计数,单线程免锁)
  2. 若 replyTo:取原信 message_id/refs → In-Reply-To、References,
     subject 缺省 "Re: …",thread_id 继承
  3. 自生成 Message-ID <ulid@yourdomain.com> 写入 headers
  4. 组装附件:小文件读 R2 转 base64;大文件生成短时效签名 URL
  5. 事务:INSERT mails(direction='out') + INSERT outbox(queued, provider_id=当前激活)
  6. 解密激活 provider 配置 → registry.create → provider.send()
  7. 成功:outbox→sent 记 provider_msg_id,配额 +1
     失败:retryable → queued 保持,attempt+1,setAlarm(指数退避);否则 → failed
```

### 7.2 alarm 重试

`alarm()` 扫 `outbox WHERE status='queued' AND next_retry_at<=now` 逐条重发;超上限(如 5 次)转 failed。前端按 outbox.status 展示 发送中 / 失败可重试 / 已送出。

### 7.3 自持与逃生

- 发出内容 100% 在自己库中(Resend 日志仅 30 天,只作辅助排查)
- outbox 记 provider_id,切换厂商不影响历史数据追溯
- 换厂商 = 后台新增配置 → 点激活,零代码零部署(新厂商类型需加一个 provider 实现文件,一次 deploy)

---

## 8. 后台与鉴权(src/api/)

### 8.1 路由

```
/                        前端 SPA(static assets)
POST /api/login          口令校验 → HMAC session cookie(HttpOnly+Secure+SameSite=Lax)
GET  /api/mails          列表(必须分页)?folder=&page=1&pageSize=20&q=
GET  /api/mails/:id      详情 + 置已读
GET  /api/threads/:tid   会话视图
POST /api/send
GET  /api/att/:id        附件下载(鉴权,流式回传 R2)
GET  /api/raw/:id        下载 .eml
GET  /r2sign/:token      Provider 拉附件专用(免 session,HMAC + 15min 时效)
/api/providers/*         §5.2
/api/rules/*             收信规则管理(支持分页)
```

### 8.2 安全

- 暴力破解防护:login_attempts 按 IP 计数锁定(状态在 DO,api 转发)
- **HTML 正文必须净化后渲染**(DOMPurify / sandbox iframe + CSP);外链图片默认不加载、点击按需(防追踪像素)——邮件是外部输入,这是全系统最大 XSS 面
- fetch handler 是唯一公网入口;DO 与 R2 不可直达。`/r2sign` 是唯一免 session 路由,靠签名 + 时效收口

### 8.3 分页规范(统一约束)

所有可能产生大量数据的列表接口(如邮件列表、发信记录、规则列表等)**严禁一次性全量返回**，必须严格执行分页规范：

- **请求参数**：统一使用 `page` (默认 1) 和 `pageSize` (默认 20，硬上限 100)。
- **返回结构**：
  ```json
  {
    "items": [...],       // 当前页数据列表
    "total": 125,         // 总条数
    "page": 1,            // 当前页码
    "pageSize": 20,       // 每页数量
    "totalPages": 7       // 总页数
  }
  ```
- **数据库层实现**：在 DO SQLite 中，利用已建好的复合索引(如 `idx_mails_list`)进行 `ORDER BY created_at DESC LIMIT ? OFFSET ?` 查询，结合 `COUNT(*)` 即可高效支撑个人级邮箱的深分页场景。


---

## 9. 部署

1. `wrangler secret put` × 3(§3 表)
2. `wrangler deploy`(一次部署包含 handler + DO + 静态资源)
3. Email Routing:Catch-all → Send to a Worker → 选本 Worker
4. 打开后台 → Providers → 新增 Resend(填 API key)→ 测试连接 → 激活

Schema 迁移:constructor 内 `blockConcurrencyWhile` 按 `meta.schema_version` 增量执行;单 Worker 部署意味着 DO 与调用方永远同版本,无跨 Worker 兼容问题。

验证清单:

- 外部发信 → 后台可见、附件/.eml 可下载;同信重投不产生重复记录
- 后台回复 → 对方端归入同一会话(threading 生效)
- 主动新发 → Gmail「显示原始邮件」SPF/DKIM 均 pass
- Provider 填错 key → verify 报错;发送失败 → outbox 重试/failed 状态可见
- 切换激活 provider → 下一封信即走新通道
- 错误口令连续尝试 → 锁定

---

## 10. 限制汇总

| 项 | 限制 | 应对 |
|---|---|---|
| 入站邮件 | ≤ 25 MiB/封(CF 硬限) | 超限自动退信 |
| email handler | 免费档 10ms CPU | 只做读流+落盘+RPC,解析在 DO |
| MailboxDO | 30s CPU/调用;单实例软上限 1000 req/s | 个人量级无感 |
| DO SQLite | 免费 1 GB/对象(账户 5 GB);满则 SQLITE_FULL | 大对象一律 R2;正文外置 |
| RPC 载荷 | 有大小限制 | 传 r2Key 不传原文 |
| Resend 免费档 | 3000/月、100/天、1 域名、5 req/s、退信率<4% | DO 配额计数;收件人格式校验 |
| Resend 出站 | ≤ 40 MB/封(base64 后计) | 大附件走签名 URL |
| waitUntil 失败不重投 | — | raw 已在 250 前同步落 R2,可补索引 |

---

## 11. 可选扩展

- **Workflow 人工审批**:rules 命中 → 建 Workflow → `step.waitForEvent()` 等人工 → 后台注入回复 → DO.send 发出
- **全文搜索**:DO SQLite 原生 FTS5,对 subject/body_text 建虚拟表
- **多身份发信**:catch-all 收到什么地址,回信 From 即用该地址(同域任意前缀均可发)
- **Provider 能力扩展**:`SupportsQuota`(余额展示)、`SupportsWebhook`(送达/退信回执 → api 回调路由 → 更新 outbox)
- **备份**:.eml 天然是标准备份;可加定时任务导出 SQLite 为 JSON 存 R2

---

## 12. 开发顺序建议

1. schema 迁移框架 + DO 的 precheck/ingest 两个 RPC(先只存不解析)
2. email handler 接通:真实邮件 → R2 + 最小索引
3. DO 补齐解析(src/mime)、附件、线程归并
4. api 只读侧:登录/列表/详情/附件下载
5. providers 抽象 + Resend 实现 + 后台 Provider 管理页
6. DO.send 编排 + outbox + alarm → 回复(threading)→ 附件外发
7. 规则、搜索、通知、扩展项

每阶段结束都是可用形态:阶段 2 即"不丢信",阶段 4 可日常收信,阶段 6 收发闭环。
