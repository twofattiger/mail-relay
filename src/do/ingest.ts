import type {
  Env,
  ForwardRule,
  IngestInput,
  IngestResult,
  PrecheckInput,
  PrecheckResult,
  Rule,
} from "../shared/types";
import { ulid } from "../shared/ulid";
import { parseEml, extractRefIds, type ParsedMail } from "../mime/parse";
import { getConfigInt } from "./config";

export interface DoCtx {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  env: Env;
}

// precheck：SMTP 会话内毫秒级决策。先按大小上限拒收，再查 rules 黑名单，最后算转发规则。
export function precheck(ctx: DoCtx, input: PrecheckInput): PrecheckResult {
  // 整封大小超上限（默认 10MB，可在设置页调整）→ 直接拒收，不落库、不进后续处理。
  const maxSize = getConfigInt(ctx, "max_mail_size");
  if (input.size > maxSize) {
    return { reject: true, reason: `Message too large (max ${maxSize} bytes)` };
  }

  const rules = loadEnabledRules(ctx);
  for (const r of rules) {
    if (r.action !== "reject") continue;
    if (matchRule(r, input.envelopeFrom, input.to, "")) {
      return { reject: true, reason: "Rejected by rule" };
    }
  }
  // 转发规则按邮件头 From/To 匹配（缺失时回退信封地址）
  const { forwards, keepOriginal } = matchForwards(
    ctx,
    input.headerFrom ?? input.envelopeFrom,
    input.headerTo ?? input.to,
  );
  return { reject: false, forwards, keepOriginal };
}

// 遍历启用的转发规则：收集去重目标；keepOriginal 为所有命中规则 keep_original 的并集
// （任一命中要求留档即留档）。无命中则正常存档（keepOriginal=true, forwards=[]）。
function matchForwards(
  ctx: DoCtx,
  from: string,
  to: string,
): { forwards: string[]; keepOriginal: boolean } {
  const targets: string[] = [];
  let anyMatched = false;
  let keep = false;
  for (const r of loadForwardRules(ctx)) {
    if (!matchForwardRule(r, from, to)) continue;
    anyMatched = true;
    if (r.keep_original) keep = true;
    const t = (r.target ?? "").trim();
    if (t && !targets.includes(t)) targets.push(t);
  }
  return { forwards: targets, keepOriginal: anyMatched ? keep : true };
}

function loadForwardRules(ctx: DoCtx): ForwardRule[] {
  return [
    ...ctx.sql.exec(`SELECT * FROM forward_rules WHERE enabled = 1`),
  ] as unknown as ForwardRule[];
}

function matchForwardRule(rule: ForwardRule, from: string, to: string): boolean {
  const mf = (rule.match_from ?? "").trim().toLowerCase();
  const mt = (rule.match_to ?? "").trim().toLowerCase();
  if (!mf && !mt) return true; // 两者皆空 = 转发所有来信
  const okFrom = !mf || from.toLowerCase().includes(mf);
  const okTo = !mt || to.toLowerCase().includes(mt);
  return okFrom && okTo;
}

export async function ingest(ctx: DoCtx, input: IngestInput): Promise<IngestResult> {
  const { sql, env } = ctx;
  const obj = await env.MAIL_R2.get(input.r2Key);
  if (!obj) {
    // raw 不在 R2：极异常，记最小兜底记录
    const mailId = ulid();
    insertMinimal(ctx, mailId, input, null);
    return { mailId, duplicate: false, needsParse: true };
  }
  const raw = new Uint8Array(await obj.arrayBuffer());

  let parsed: ParsedMail;
  try {
    parsed = await parseEml(raw);
  } catch {
    // 解析失败兜底：写 needs_parse 最小记录，不静默丢失
    const mailId = ulid();
    insertMinimal(ctx, mailId, input, input.r2Key);
    return { mailId, duplicate: false, needsParse: true };
  }

  // 幂等去重：message_id 命中已有记录则直接返回
  if (parsed.messageId) {
    const dup = [
      ...sql.exec(`SELECT id FROM mails WHERE message_id = ?`, parsed.messageId),
    ] as Array<{ id: string }>;
    if (dup.length) {
      return { mailId: dup[0].id, duplicate: true, needsParse: false };
    }
  }

  const mailId = ulid();
  const now = Date.now();

  // 线程归并：In-Reply-To/References 任一命中 → 沿用其 thread_id；否则自身为线程根
  const threadId = resolveThreadId(ctx, parsed, mailId);

  // 附件写 R2 + 表
  for (const att of parsed.attachments) {
    const attId = ulid();
    const key = `att/${mailId}/${attId}/${sanitize(att.filename)}`;
    await env.MAIL_R2.put(key, att.content, {
      httpMetadata: att.mimeType ? { contentType: att.mimeType } : undefined,
    });
    sql.exec(
      `INSERT INTO attachments (id, mail_id, filename, mime_type, size_bytes, r2_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      attId,
      mailId,
      att.filename,
      att.mimeType,
      att.size,
      key,
    );
  }

  // 正文外置：body_html 超阈值 → 写 R2，列置 NULL
  let bodyHtml: string | null = parsed.html;
  let bodyR2Key: string | null = null;
  if (bodyHtml && byteLen(bodyHtml) > getConfigInt(ctx, "body_inline_max")) {
    bodyR2Key = `body/${mailId}.html`;
    await env.MAIL_R2.put(bodyR2Key, bodyHtml, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    bodyHtml = null;
  }

  // body_text 截断 64KB 保护索引
  const bodyText = parsed.text ? truncate(parsed.text, 64 * 1024) : null;

  // rules 自动归档
  const folder = classifyFolder(ctx, parsed);

  sql.exec(
    `INSERT INTO mails
      (id, direction, message_id, thread_id, from_addr, envelope_from, to_addr,
       subject, snippet, body_text, body_html, body_r2_key, raw_r2_key,
       in_reply_to, refs, size_bytes, is_read, folder, needs_parse, created_at)
     VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
    mailId,
    parsed.messageId,
    threadId,
    parsed.from,
    input.envelopeFrom,
    parsed.to || input.envelopeTo,
    parsed.subject,
    parsed.snippet,
    bodyText,
    bodyHtml,
    bodyR2Key,
    input.r2Key,
    parsed.inReplyTo,
    parsed.references,
    input.size,
    folder,
    now,
  );

  return { mailId, duplicate: false, needsParse: false };
}

function resolveThreadId(ctx: DoCtx, parsed: ParsedMail, selfId: string): string {
  const refIds = extractRefIds(parsed.inReplyTo, parsed.references);
  for (const rid of refIds) {
    const hit = [
      ...ctx.sql.exec(`SELECT thread_id FROM mails WHERE message_id = ? LIMIT 1`, rid),
    ] as Array<{ thread_id: string }>;
    if (hit.length) return hit[0].thread_id;
  }
  // 新线程：优先用自身 message_id 作 thread 根，缺失则用 mailId
  return parsed.messageId ?? selfId;
}

function classifyFolder(ctx: DoCtx, parsed: ParsedMail): string {
  const rules = loadEnabledRules(ctx);
  for (const r of rules) {
    if (r.action === "reject") continue;
    if (matchRule(r, parsed.fromAddr, parsed.to, parsed.subject ?? "")) {
      if (r.action === "spam") return "spam";
      if (r.action === "trash") return "trash";
    }
  }
  return "inbox";
}

function loadEnabledRules(ctx: DoCtx): Rule[] {
  return [...ctx.sql.exec(`SELECT * FROM rules WHERE enabled = 1`)] as unknown as Rule[];
}

function matchRule(rule: Rule, from: string, to: string, subject: string): boolean {
  const hay =
    rule.kind === "from"
      ? from
      : rule.kind === "to"
        ? to
        : rule.kind === "subject"
          ? subject
          : `${from} ${to} ${subject}`;
  const pat = rule.pattern.toLowerCase();
  return hay.toLowerCase().includes(pat);
}

function insertMinimal(
  ctx: DoCtx,
  mailId: string,
  input: IngestInput,
  rawKey: string | null,
): void {
  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO mails
      (id, direction, message_id, thread_id, from_addr, envelope_from, to_addr,
       subject, snippet, size_bytes, folder, needs_parse, raw_r2_key, created_at)
     VALUES (?, 'in', NULL, ?, ?, ?, ?, '(解析失败)', '邮件解析失败，可下载原始 .eml',
             ?, 'inbox', 1, ?, ?)`,
    mailId,
    mailId,
    input.envelopeFrom,
    input.envelopeFrom,
    input.envelopeTo,
    input.size,
    rawKey,
    now,
  );
}

function sanitize(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 128) || "file";
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncate(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  // 粗略按字符截断到字节上限内
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(s.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}
