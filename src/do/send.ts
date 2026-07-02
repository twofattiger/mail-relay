import type { Attachment, Env, SendInput, SendResultDTO } from "../shared/types";
import { ulid } from "../shared/ulid";
import { makeR2Token } from "../shared/sign";
import { getProviderDef } from "../providers/registry";
import { ProviderError, type OutgoingAttachment } from "../providers/types";
import { decryptJson } from "./crypto";
import type { DoCtx } from "./ingest";

const ATTACH_INLINE_MAX = 10 * 1024 * 1024; // ≤10MB 内联 base64，更大走签名 URL
const R2_TOKEN_TTL = 15 * 60 * 1000; // 15 分钟
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60 * 1000; // 指数退避基数

function dailyLimit(env: Env): number {
  return parseInt(env.DAILY_SEND_LIMIT ?? "100", 10) || 100;
}

function mailDomain(from: string): string {
  const m = from.match(/@([^>\s]+)/);
  return m ? m[1] : "localhost";
}

// ─── 每日配额（meta 计数，DO 单线程免锁）───
function todayKey(): string {
  return "send_count:" + new Date().toISOString().slice(0, 10);
}
function getSendCount(ctx: DoCtx): number {
  const rows = [
    ...ctx.sql.exec(`SELECT value FROM meta WHERE key = ?`, todayKey()),
  ] as Array<{ value: string }>;
  return rows.length ? parseInt(rows[0].value, 10) || 0 : 0;
}
function bumpSendCount(ctx: DoCtx): void {
  const next = getSendCount(ctx) + 1;
  ctx.sql.exec(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    todayKey(),
    String(next),
  );
}

export async function send(ctx: DoCtx, input: SendInput): Promise<SendResultDTO> {
  const { sql, env } = ctx;

  // 1. 配额检查
  if (getSendCount(ctx) >= dailyLimit(env)) {
    throw new Error("已达每日发送配额上限");
  }

  // 激活 provider
  const active = [
    ...sql.exec(`SELECT * FROM providers WHERE is_active = 1 LIMIT 1`),
  ] as Array<{ id: string; type: string; config_enc: string }>;
  if (!active.length) {
    throw new Error("没有激活的发送 Provider");
  }
  const provider = active[0];

  const now = Date.now();
  const mailId = ulid(now);
  const domain = mailDomain(input.from);
  const messageId = `<${mailId}@${domain}>`;

  // 2. replyTo：继承 threading
  const headers: Record<string, string> = { "Message-ID": messageId };
  let threadId = messageId;
  let subject = input.subject;
  if (input.replyToMailId) {
    const orig = [
      ...sql.exec(
        `SELECT message_id, thread_id, refs, subject FROM mails WHERE id = ?`,
        input.replyToMailId,
      ),
    ] as Array<{
      message_id: string | null;
      thread_id: string;
      refs: string | null;
      subject: string | null;
    }>;
    if (orig.length) {
      const o = orig[0];
      threadId = o.thread_id;
      if (o.message_id) {
        headers["In-Reply-To"] = o.message_id;
        headers["References"] = [o.refs, o.message_id].filter(Boolean).join(" ");
      }
      if (!subject && o.subject) {
        subject = o.subject.startsWith("Re:") ? o.subject : `Re: ${o.subject}`;
      }
    }
  }

  // 4. 组装附件
  const outAttachments = await buildAttachments(ctx, input);

  // 5. 事务：写 mails(out) + outbox(queued)
  const outboxId = ulid(now);
  const toAddr = input.to.join(", ");
  sql.exec(
    `INSERT INTO mails
      (id, direction, message_id, thread_id, from_addr, to_addr, subject,
       snippet, body_text, body_html, in_reply_to, refs, folder, is_read,
       needs_parse, created_at)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 1, 0, ?)`,
    mailId,
    messageId,
    threadId,
    input.from,
    toAddr,
    subject,
    makeSnippetFrom(input),
    input.text ?? null,
    input.html ?? null,
    headers["In-Reply-To"] ?? null,
    headers["References"] ?? null,
    now,
  );
  sql.exec(
    `INSERT INTO outbox (id, mail_id, provider_id, status, attempt, next_retry_at)
     VALUES (?, ?, ?, 'queued', 0, NULL)`,
    outboxId,
    mailId,
    provider.id,
  );

  // 6+7. 解密配置 → 构造 provider → 发送
  const result = await attemptSend(ctx, outboxId, {
    providerType: provider.type,
    configEnc: provider.config_enc,
    from: input.from,
    to: input.to,
    subject: subject ?? "",
    html: input.html,
    text: input.text,
    headers,
    attachments: outAttachments,
  });

  return { mailId, outboxId, status: result.status, error: result.error };
}

interface AttemptPayload {
  providerType: string;
  configEnc: string;
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  attachments: OutgoingAttachment[];
}

// 单次投递尝试：更新 outbox 状态；成功计配额，retryable 失败排 alarm，否则 failed
async function attemptSend(
  ctx: DoCtx,
  outboxId: string,
  payload: AttemptPayload,
): Promise<{ status: "sent" | "queued" | "failed"; error?: string }> {
  const { sql, env, storage } = ctx;
  const def = getProviderDef(payload.providerType);
  if (!def) {
    sql.exec(
      `UPDATE outbox SET status='failed', last_error=? WHERE id=?`,
      `未知 Provider 类型: ${payload.providerType}`,
      outboxId,
    );
    return { status: "failed", error: "未知 Provider 类型" };
  }

  try {
    const config = await decryptJson<Record<string, string>>(
      env.CONFIG_MASTER_KEY,
      payload.configEnc,
    );
    const provider = def.create(config);
    const res = await provider.send({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: payload.headers,
      attachments: payload.attachments,
    });
    sql.exec(
      `UPDATE outbox SET status='sent', provider_msg_id=?, last_error=NULL WHERE id=?`,
      res.providerMessageId,
      outboxId,
    );
    bumpSendCount(ctx);
    return { status: "sent" };
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : false;
    const msg = e instanceof Error ? e.message : String(e);
    const row = [
      ...sql.exec(`SELECT attempt FROM outbox WHERE id=?`, outboxId),
    ] as Array<{ attempt: number }>;
    const attempt = (row.length ? row[0].attempt : 0) + 1;

    if (retryable && attempt < MAX_ATTEMPTS) {
      const nextRetryAt = Date.now() + RETRY_BASE_MS * Math.pow(2, attempt - 1);
      sql.exec(
        `UPDATE outbox SET status='queued', attempt=?, last_error=?, next_retry_at=? WHERE id=?`,
        attempt,
        msg,
        nextRetryAt,
        outboxId,
      );
      await storage.setAlarm(nextRetryAt);
      return { status: "queued", error: msg };
    }

    sql.exec(
      `UPDATE outbox SET status='failed', attempt=?, last_error=?, next_retry_at=NULL WHERE id=?`,
      attempt,
      msg,
      outboxId,
    );
    return { status: "failed", error: msg };
  }
}

// alarm：重发到期 queued 项
export async function runAlarm(ctx: DoCtx): Promise<void> {
  const { sql } = ctx;
  const now = Date.now();
  const due = [
    ...sql.exec(
      `SELECT o.id AS outbox_id, o.mail_id, o.provider_id,
              m.from_addr, m.to_addr, m.subject, m.body_html, m.body_text,
              m.message_id, m.in_reply_to, m.refs,
              p.type AS provider_type, p.config_enc
       FROM outbox o
       JOIN mails m ON m.id = o.mail_id
       JOIN providers p ON p.id = o.provider_id
       WHERE o.status='queued' AND o.next_retry_at IS NOT NULL AND o.next_retry_at <= ?`,
      now,
    ),
  ] as Array<{
    outbox_id: string;
    from_addr: string;
    to_addr: string;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    message_id: string | null;
    in_reply_to: string | null;
    refs: string | null;
    provider_type: string;
    config_enc: string;
  }>;

  for (const d of due) {
    const headers: Record<string, string> = {};
    if (d.message_id) headers["Message-ID"] = d.message_id;
    if (d.in_reply_to) headers["In-Reply-To"] = d.in_reply_to;
    if (d.refs) headers["References"] = d.refs;
    await attemptSend(ctx, d.outbox_id, {
      providerType: d.provider_type,
      configEnc: d.config_enc,
      from: d.from_addr,
      to: splitAddrs(d.to_addr),
      subject: d.subject ?? "",
      html: d.body_html ?? undefined,
      text: d.body_text ?? undefined,
      headers,
      attachments: [], // 重试沿用正文；附件重试暂不重建（大附件已过签名 URL 时效）
    });
  }

  // 若仍有未来到期项，续排下一次 alarm
  const nextRows = [
    ...sql.exec(
      `SELECT MIN(next_retry_at) AS next FROM outbox
       WHERE status='queued' AND next_retry_at IS NOT NULL AND next_retry_at > ?`,
      now,
    ),
  ] as Array<{ next: number | null }>;
  if (nextRows.length && nextRows[0].next) {
    await ctx.storage.setAlarm(nextRows[0].next);
  }
}

async function buildAttachments(
  ctx: DoCtx,
  input: SendInput,
): Promise<OutgoingAttachment[]> {
  if (!input.attachmentIds?.length) return [];
  const out: OutgoingAttachment[] = [];
  for (const attId of input.attachmentIds) {
    const rows = [
      ...ctx.sql.exec(`SELECT * FROM attachments WHERE id = ?`, attId),
    ] as unknown as Attachment[];
    if (!rows.length) continue;
    const att = rows[0];
    const size = att.size_bytes ?? 0;
    if (size <= ATTACH_INLINE_MAX) {
      const obj = await ctx.env.MAIL_R2.get(att.r2_key);
      if (!obj) continue;
      const content = toBase64(new Uint8Array(await obj.arrayBuffer()));
      out.push({
        filename: att.filename,
        content,
        contentType: att.mime_type ?? undefined,
      });
    } else if (input.origin) {
      // 大附件：短时效签名 URL，provider 自行拉取
      const token = await makeR2Token(ctx.env.SESSION_SECRET, att.id, R2_TOKEN_TTL);
      out.push({
        filename: att.filename,
        url: `${input.origin}/r2sign/${token}`,
        contentType: att.mime_type ?? undefined,
      });
    }
  }
  return out;
}

function makeSnippetFrom(input: SendInput): string {
  const src = input.text ?? (input.html ? input.html.replace(/<[^>]+>/g, " ") : "");
  return src.replace(/\s+/g, " ").trim().slice(0, 200);
}

function splitAddrs(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
