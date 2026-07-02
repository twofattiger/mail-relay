// 平台绑定与全局环境
export interface Env {
  MAILBOX: DurableObjectNamespace<import("../do/mailbox").MailboxDO>;
  MAIL_R2: R2Bucket;
  ASSETS?: Fetcher;
  // secrets
  CONFIG_MASTER_KEY: string;
  SESSION_SECRET: string;
  ADMIN_PASSWORD: string;
  // vars
  DAILY_SEND_LIMIT?: string;
  BODY_INLINE_MAX?: string;
  LOGIN_MAX_FAILS?: string;
  LOGIN_LOCK_SECONDS?: string;
}

export type MailDirection = "in" | "out";
export type MailFolder = "inbox" | "sent" | "spam" | "trash";

// 存储层完整邮件记录（对应 mails 表）
export interface Mail {
  id: string;
  direction: MailDirection;
  message_id: string | null;
  thread_id: string;
  from_addr: string;
  envelope_from: string | null;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  body_r2_key: string | null;
  raw_r2_key: string | null;
  in_reply_to: string | null;
  refs: string | null;
  size_bytes: number | null;
  is_read: number;
  folder: MailFolder;
  needs_parse: number;
  created_at: number;
}

// 列表页精简视图
export interface MailListItem {
  id: string;
  direction: MailDirection;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  snippet: string | null;
  is_read: number;
  folder: MailFolder;
  has_attachments: number;
  created_at: number;
}

export interface Attachment {
  id: string;
  mail_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string;
}

// 详情视图：邮件 + 附件（正文可能来自 R2）
export interface MailDetail extends Mail {
  attachments: Attachment[];
}

export interface ProviderRow {
  id: string;
  type: string;
  name: string;
  is_active: number;
  last_verified_at: number | null;
  created_at: number | null;
  updated_at: number | null;
}

// 打码后的 Provider 配置（返回前端用）
export interface ProviderView extends ProviderRow {
  config: Record<string, string>; // secret 字段值为打码占位
}

export type OutboxStatus = "queued" | "sent" | "failed";

export interface OutboxRow {
  id: string;
  mail_id: string;
  provider_id: string;
  provider_msg_id: string | null;
  status: OutboxStatus;
  attempt: number;
  last_error: string | null;
  next_retry_at: number | null;
}

export interface Rule {
  id: string;
  kind: string; // 'from' | 'subject' | ...
  pattern: string;
  action: string; // 'reject' | 'spam' | 'trash'
  enabled: number;
}

// 转发规则（对应 forward_rules 表）：邮件头 From/To 复合匹配 → 转发到 target
export interface ForwardRule {
  id: string;
  match_from: string | null;
  match_to: string | null;
  target: string;
  keep_original: number; // 1=转发并存档；0=转发后不存档
  enabled: number;
  created_at: number | null;
}

// ─── RPC DTO ───────────────────────────────────────────────

export interface PrecheckInput {
  envelopeFrom: string;
  to: string;
  size: number;
  headerFrom?: string; // 邮件头 From（转发规则匹配用；缺失时回退信封 from）
  headerTo?: string; // 邮件头 To（转发规则匹配用；缺失时回退信封 to）
}
export interface PrecheckResult {
  reject: boolean;
  reason?: string;
  forwards?: string[]; // 命中转发规则需转发的目标地址（已去重）
  keepOriginal?: boolean; // 转发命中时是否仍存档；无命中恒为 true
}

export interface IngestInput {
  r2Key: string;
  envelopeFrom: string;
  envelopeTo: string;
  size: number;
}
export interface IngestResult {
  mailId: string;
  duplicate: boolean;
  needsParse: boolean;
}

export interface SendInput {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  replyToMailId?: string;
  attachmentIds?: string[];
  from: string; // 发件地址（多身份发信，同域任意前缀）
  origin?: string; // 请求来源 origin，用于生成大附件签名 URL
}
export interface SendResultDTO {
  mailId: string;
  outboxId: string;
  status: OutboxStatus;
  error?: string;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  q?: string;
  folder?: MailFolder;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Provider 管理 DTO
export interface CreateProviderInput {
  type: string;
  name: string;
  config: Record<string, string>;
}
export interface UpdateProviderInput {
  id: string;
  name?: string;
  config?: Record<string, string>; // secret 字段留空 = 不变更
}
export interface VerifyResult {
  ok: boolean;
  error?: string;
}

// 规则管理 DTO
export interface UpsertRuleInput {
  id?: string;
  kind: string;
  pattern: string;
  action: string;
  enabled: boolean;
}

// 转发规则管理 DTO
export interface UpsertForwardRuleInput {
  id?: string;
  matchFrom?: string; // 空 = 任意发件人
  matchTo?: string; // 空 = 任意收件人
  target: string;
  keepOriginal: boolean;
  enabled: boolean;
}

// 登录暴力破解防护 DTO
export interface LoginCheckResult {
  locked: boolean;
  lockedUntil?: number;
}
