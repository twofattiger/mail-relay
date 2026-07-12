// DO 模式周期维护：pending 孤儿附件 GC + 历史邮件清理。
// 仅在 DO 模式调用（R2 模式容量充裕、无本地清理需求，且 blobs 表恒空）。
// 由 MailboxDO.alarm() 驱动，通过 meta.maintenance_last_at 节流为至多每日一次。

import type { DoCtx } from "./ingest";
import { getConfigInt } from "./config";

/** 维护心跳周期：每日一次。alarm 自身续期形成周期性。 */
export const MAINTENANCE_INTERVAL_MS = 24 * 3600 * 1000;

/** pending 孤儿附件保留时长：撰写页上传后 24h 未发送即视为孤儿。 */
const PENDING_TTL_MS = 24 * 3600 * 1000;

const LAST_KEY = "maintenance_last_at";

// alarm 也会因出站重试而提前触发，节流避免每次重试都跑一遍清理扫描。
function maintenanceDue(ctx: DoCtx): boolean {
  const rows = [
    ...ctx.sql.exec(`SELECT value FROM meta WHERE key = ?`, LAST_KEY),
  ] as Array<{ value: string }>;
  const last = rows.length ? parseInt(rows[0].value, 10) || 0 : 0;
  return Date.now() - last >= MAINTENANCE_INTERVAL_MS;
}

function markMaintenance(ctx: DoCtx): void {
  ctx.sql.exec(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    LAST_KEY,
    String(Date.now()),
  );
}

/** 周期维护入口。到期才执行；执行前先打时间戳，避免并发/重入重复扫描。 */
export async function runMaintenance(ctx: DoCtx): Promise<void> {
  if (!maintenanceDue(ctx)) return;
  markMaintenance(ctx);
  await gcPendingBlobs(ctx);
  await purgeExpiredMails(ctx);
}

// 清理超过 24h 的 pending blob（撰写页上传后未发送的孤儿附件）。
// R2 模式可用 lifecycle 规则；DO 模式无此机制，否则持续吃掉配额。
async function gcPendingBlobs(ctx: DoCtx): Promise<void> {
  const cutoff = Date.now() - PENDING_TTL_MS;
  // LIKE 模式串限 50 字节 —— 'pending/%' 远低于上限，安全。
  const stale = [
    ...ctx.sql.exec(
      `SELECT key FROM blobs WHERE key LIKE 'pending/%' AND created_at < ?`,
      cutoff,
    ),
  ] as Array<{ key: string }>;
  for (const { key } of stale) await ctx.blob.delete(key);
}

// 历史邮件清理：按「保留天数」和「最大条数」两条策略，任一命中即删整条邮件。
// 两项均以 config 表配置，0 = 关闭。in-flight（outbox=queued）邮件跳过，防止误删发送中的信。
async function purgeExpiredMails(ctx: DoCtx): Promise<void> {
  const days = getConfigInt(ctx, "do_retention_days"); // 0 = 关闭
  const maxCount = getConfigInt(ctx, "do_retention_max_count"); // 0 = 关闭
  if (days <= 0 && maxCount <= 0) return;

  const ids = new Set<string>();

  if (days > 0) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    for (const r of ctx.sql.exec(
      `SELECT id FROM mails WHERE created_at < ?`,
      cutoff,
    )) {
      ids.add((r as { id: string }).id);
    }
  }

  if (maxCount > 0) {
    // 保留最新 maxCount 条，其余（更旧的）纳入清理。OFFSET 跳过要保留的。
    for (const r of ctx.sql.exec(
      `SELECT id FROM mails ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      maxCount,
    )) {
      ids.add((r as { id: string }).id);
    }
  }

  if (!ids.size) return;

  // 排除发送中的邮件（outbox=queued），避免删掉正在重试投递的信。
  const queued = new Set(
    [
      ...ctx.sql.exec(`SELECT mail_id FROM outbox WHERE status = 'queued'`),
    ].map((r) => (r as { mail_id: string }).mail_id),
  );

  for (const id of ids) {
    if (queued.has(id)) continue;
    await purgeMail(ctx, id);
  }
}

/**
 * 永久删除单封邮件：清理 blob（附件 / 外置正文 / 原始 .eml）后删表行。
 * MailboxDO.purgeMail 与历史清理共用此实现，保证删除行为一致。
 */
export async function purgeMail(ctx: DoCtx, id: string): Promise<void> {
  const mailRows = [
    ...ctx.sql.exec(`SELECT body_r2_key, raw_r2_key FROM mails WHERE id = ?`, id),
  ] as Array<{ body_r2_key: string | null; raw_r2_key: string | null }>;
  if (!mailRows.length) return;
  const attRows = [
    ...ctx.sql.exec(`SELECT r2_key FROM attachments WHERE mail_id = ?`, id),
  ] as Array<{ r2_key: string }>;

  const keys = [
    mailRows[0].body_r2_key,
    mailRows[0].raw_r2_key,
    ...attRows.map((a) => a.r2_key),
  ].filter((k): k is string => !!k);
  // 并行删除 blob；用 allSettled 容错：个别删除失败也不阻断表行清理，避免删不干净。
  await Promise.allSettled(keys.map((key) => ctx.blob.delete(key)));

  ctx.sql.exec(`DELETE FROM attachments WHERE mail_id = ?`, id);
  ctx.sql.exec(`DELETE FROM outbox WHERE mail_id = ?`, id);
  ctx.sql.exec(`DELETE FROM mails WHERE id = ?`, id);
}
