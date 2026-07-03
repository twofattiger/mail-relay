// 通讯录读写。判重以邮箱为准（email UNIQUE，统一小写）。DO 单线程免锁。

import type { Contact, Page, PageQuery } from "../shared/types";
import { buildPage } from "../shared/http";
import { ulid } from "../shared/ulid";
import type { DoCtx } from "./ingest";

// 解析 "Name <a@b>" 或纯地址 → { name, email(小写) }。email 空表示无法解析。
export function parseAddress(raw: string): { name: string; email: string } {
  const s = (raw ?? "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m) {
    const email = m[1].trim().toLowerCase();
    // 尖括号前是显示名，去除包裹引号
    const name = s.slice(0, m.index).trim().replace(/^["']|["']$/g, "");
    return { name, email };
  }
  return { name: "", email: s.toLowerCase() };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function isEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function listContacts(ctx: DoCtx, q: PageQuery): Page<Contact> {
  const like = q.q ? `%${q.q}%` : null;
  const where = like ? `WHERE name LIKE ? OR email LIKE ?` : "";
  const args = like ? [like, like] : [];

  const totalRow = [
    ...ctx.sql.exec(`SELECT COUNT(*) AS c FROM contacts ${where}`, ...args),
  ] as Array<{ c: number }>;
  const total = totalRow[0]?.c ?? 0;

  const items = [
    ...ctx.sql.exec(
      `SELECT id, name, email, created_at, updated_at FROM contacts ${where}
       ORDER BY (name IS NULL OR name = ''), name COLLATE NOCASE, email
       LIMIT ? OFFSET ?`,
      ...args,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ),
  ] as unknown as Contact[];

  return buildPage(items, total, q);
}

// 新增/更新：邮箱冲突则更新 name（仅当新 name 非空，避免把已有名字清空）。
export function upsertContact(
  ctx: DoCtx,
  input: { id?: string; name?: string; email: string },
): { id: string } {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) throw new Error("邮箱格式不正确");
  const name = (input.name ?? "").trim();
  const now = Date.now();

  // 编辑既有条目（可改名/改邮箱）
  if (input.id) {
    ctx.sql.exec(
      `UPDATE contacts SET name = ?, email = ?, updated_at = ? WHERE id = ?`,
      name,
      email,
      now,
      input.id,
    );
    return { id: input.id };
  }

  const existing = [
    ...ctx.sql.exec(`SELECT id FROM contacts WHERE email = ?`, email),
  ] as Array<{ id: string }>;
  if (existing.length) {
    if (name) {
      ctx.sql.exec(
        `UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?`,
        name,
        now,
        existing[0].id,
      );
    }
    return { id: existing[0].id };
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO contacts (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    name,
    email,
    now,
    now,
  );
  return { id };
}

// 自动保存：仅当邮箱不存在时插入，绝不覆盖用户已编辑的名字。
export function saveContactIfAbsent(ctx: DoCtx, email: string, name: string): void {
  const e = (email ?? "").trim().toLowerCase();
  if (!isEmail(e)) return;
  const existing = [
    ...ctx.sql.exec(`SELECT id FROM contacts WHERE email = ?`, e),
  ] as Array<{ id: string }>;
  if (existing.length) return;
  const id = ulid();
  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO contacts (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    (name ?? "").trim(),
    e,
    now,
    now,
  );
}

export function contactExists(ctx: DoCtx, email: string): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  const rows = [
    ...ctx.sql.exec(`SELECT 1 FROM contacts WHERE email = ? LIMIT 1`, e),
  ] as Array<unknown>;
  return rows.length > 0;
}

export function deleteContact(ctx: DoCtx, id: string): void {
  ctx.sql.exec(`DELETE FROM contacts WHERE id = ?`, id);
}
