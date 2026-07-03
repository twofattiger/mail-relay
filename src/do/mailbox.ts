import { DurableObject } from "cloudflare:workers";
import type {
  Contact,
  CreateProviderInput,
  Env,
  ForwardRule,
  IngestInput,
  IngestResult,
  LoginCheckResult,
  Mail,
  MailDetail,
  MailListItem,
  OutboxRow,
  Page,
  PageQuery,
  PrecheckInput,
  PrecheckResult,
  ProviderView,
  Rule,
  SendInput,
  SendResultDTO,
  UpdateProviderInput,
  UpsertForwardRuleInput,
  UpsertRuleInput,
  VerifyResult,
} from "../shared/types";
import type { SettingsDTO, UpdateSettingsInput, UpsertContactInput } from "../shared/types";
import { buildPage } from "../shared/http";
import { ulid } from "../shared/ulid";
import { getProviderDef, listProviderDefs } from "../providers/registry";
import { encryptJson, decryptJson } from "./crypto";
import { runMigrations } from "./schema";
import { getConfig, setConfig, getConfigInt } from "./config";
import {
  contactExists,
  deleteContact as doDeleteContact,
  listContacts as doListContacts,
  parseAddress,
  upsertContact as doUpsertContact,
} from "./contacts";
import { hashPassword, verifyPassword } from "../shared/password";
import { precheck as doPrecheck, ingest as doIngest, type DoCtx } from "./ingest";
import { send as doSend, runAlarm, retryOutbox as doRetryOutbox } from "./send";

const SECRET_MASK = "••••••••";

export class MailboxDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.storage = state.storage;
    state.blockConcurrencyWhile(async () => {
      runMigrations(this.sql);
    });
  }

  private doCtx(): DoCtx {
    return { sql: this.sql, storage: this.storage, env: this.env };
  }

  // ─── 收信 ───
  precheck(input: PrecheckInput): PrecheckResult {
    return doPrecheck(this.doCtx(), input);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    return doIngest(this.doCtx(), input);
  }

  // ─── 发信 ───
  async send(input: SendInput): Promise<SendResultDTO> {
    return doSend(this.doCtx(), input);
  }

  async alarm(): Promise<void> {
    await runAlarm(this.doCtx());
  }

  // ─── 邮件读取 ───
  listMails(q: PageQuery): Page<MailListItem> {
    const folder = q.folder ?? "inbox";
    const like = q.q ? `%${q.q}%` : null;
    const where = like
      ? `folder = ? AND (subject LIKE ? OR from_addr LIKE ? OR snippet LIKE ?)`
      : `folder = ?`;
    const args = like ? [folder, like, like, like] : [folder];

    const totalRow = [
      ...this.sql.exec(`SELECT COUNT(*) AS c FROM mails WHERE ${where}`, ...args),
    ] as Array<{ c: number }>;
    const total = totalRow[0]?.c ?? 0;

    const items = [
      ...this.sql.exec(
        `SELECT m.id, m.direction, m.thread_id, m.from_addr, m.to_addr, m.subject,
                m.snippet, m.is_read, m.folder, m.created_at,
                (SELECT COUNT(*) FROM attachments a WHERE a.mail_id = m.id) AS has_attachments,
                o.status AS send_status, o.last_error AS send_error
         FROM mails m LEFT JOIN outbox o ON o.mail_id = m.id
         WHERE ${where}
         ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        ...args,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ),
    ] as unknown as MailListItem[];

    return buildPage(items, total, q);
  }

  async getMail(id: string): Promise<MailDetail | null> {
    const rows = [
      ...this.sql.exec(`SELECT * FROM mails WHERE id = ?`, id),
    ] as unknown as Mail[];
    if (!rows.length) return null;
    const mail = rows[0];

    // 置已读
    if (!mail.is_read) {
      this.sql.exec(`UPDATE mails SET is_read = 1 WHERE id = ?`, id);
      mail.is_read = 1;
    }

    // 正文外置则从 R2 拉取
    if (mail.body_r2_key && !mail.body_html) {
      const obj = await this.env.MAIL_R2.get(mail.body_r2_key);
      if (obj) mail.body_html = await obj.text();
    }

    const attachments = [
      ...this.sql.exec(`SELECT * FROM attachments WHERE mail_id = ?`, id),
    ] as unknown as MailDetail["attachments"];

    // 发件人是否已在通讯录（详情页据此决定是否显示「存入通讯录」）
    const fromEmail = parseAddress(mail.from_addr).email;
    const from_saved = contactExists(this.doCtx(), fromEmail);

    return { ...mail, attachments, from_saved };
  }

  getThread(threadId: string): Mail[] {
    return [
      ...this.sql.exec(
        `SELECT * FROM mails WHERE thread_id = ? ORDER BY created_at ASC`,
        threadId,
      ),
    ] as unknown as Mail[];
  }

  // 附件元数据（api 层据此流式回传 R2）
  getAttachment(id: string): { r2_key: string; filename: string; mime_type: string | null } | null {
    const rows = [
      ...this.sql.exec(
        `SELECT r2_key, filename, mime_type FROM attachments WHERE id = ?`,
        id,
      ),
    ] as Array<{ r2_key: string; filename: string; mime_type: string | null }>;
    return rows.length ? rows[0] : null;
  }

  getRawKey(mailId: string): string | null {
    const rows = [
      ...this.sql.exec(`SELECT raw_r2_key FROM mails WHERE id = ?`, mailId),
    ] as Array<{ raw_r2_key: string | null }>;
    return rows.length ? rows[0].raw_r2_key : null;
  }

  // outbox 状态（前端展示 发送中/失败可重试/已送出；测试断言用）
  getOutbox(outboxId: string): OutboxRow | null {
    const rows = [
      ...this.sql.exec(`SELECT * FROM outbox WHERE id = ?`, outboxId),
    ] as unknown as OutboxRow[];
    return rows.length ? rows[0] : null;
  }

  // ─── Provider 管理 ───
  listProviderSchemas() {
    return listProviderDefs().map((d) => ({
      type: d.type,
      displayName: d.displayName,
      configSchema: d.configSchema,
    }));
  }

  async listProviders(): Promise<ProviderView[]> {
    const rows = [
      ...this.sql.exec(
        `SELECT id, type, name, config_enc, is_active, last_verified_at, created_at, updated_at
         FROM providers ORDER BY created_at DESC`,
      ),
    ] as Array<{
      id: string;
      type: string;
      name: string;
      config_enc: string;
      is_active: number;
      last_verified_at: number | null;
      created_at: number | null;
      updated_at: number | null;
    }>;

    const out: ProviderView[] = [];
    for (const r of rows) {
      const def = getProviderDef(r.type);
      let config: Record<string, string> = {};
      try {
        const raw = await decryptJson<Record<string, string>>(
          this.env.CONFIG_MASTER_KEY,
          r.config_enc,
        );
        config = maskSecrets(raw, def?.configSchema ?? []);
      } catch {
        config = {};
      }
      out.push({
        id: r.id,
        type: r.type,
        name: r.name,
        is_active: r.is_active,
        last_verified_at: r.last_verified_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        config,
      });
    }
    return out;
  }

  async createProvider(input: CreateProviderInput): Promise<{ id: string }> {
    const def = getProviderDef(input.type);
    if (!def) throw new Error(`未知 Provider 类型: ${input.type}`);
    validateRequired(def.configSchema, input.config);
    const id = ulid();
    const now = Date.now();
    const enc = await encryptJson(this.env.CONFIG_MASTER_KEY, input.config);
    this.sql.exec(
      `INSERT INTO providers (id, type, name, config_enc, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      id,
      input.type,
      input.name,
      enc,
      now,
      now,
    );
    return { id };
  }

  async updateProvider(input: UpdateProviderInput): Promise<void> {
    const rows = [
      ...this.sql.exec(`SELECT type, config_enc FROM providers WHERE id = ?`, input.id),
    ] as Array<{ type: string; config_enc: string }>;
    if (!rows.length) throw new Error("Provider 不存在");
    const def = getProviderDef(rows[0].type);

    let encToStore = rows[0].config_enc;
    if (input.config) {
      // secret 字段留空 = 不变更：与旧配置合并
      const existing = await decryptJson<Record<string, string>>(
        this.env.CONFIG_MASTER_KEY,
        rows[0].config_enc,
      );
      const merged = mergeConfig(existing, input.config, def?.configSchema ?? []);
      encToStore = await encryptJson(this.env.CONFIG_MASTER_KEY, merged);
    }
    const now = Date.now();
    if (input.name !== undefined) {
      this.sql.exec(
        `UPDATE providers SET name=?, config_enc=?, updated_at=? WHERE id=?`,
        input.name,
        encToStore,
        now,
        input.id,
      );
    } else {
      this.sql.exec(
        `UPDATE providers SET config_enc=?, updated_at=? WHERE id=?`,
        encToStore,
        now,
        input.id,
      );
    }
  }

  async verifyProvider(id: string): Promise<VerifyResult> {
    const rows = [
      ...this.sql.exec(`SELECT type, config_enc FROM providers WHERE id = ?`, id),
    ] as Array<{ type: string; config_enc: string }>;
    if (!rows.length) return { ok: false, error: "Provider 不存在" };
    const def = getProviderDef(rows[0].type);
    if (!def) return { ok: false, error: "未知 Provider 类型" };
    try {
      const config = await decryptJson<Record<string, string>>(
        this.env.CONFIG_MASTER_KEY,
        rows[0].config_enc,
      );
      await def.create(config).verifyConfig();
      this.sql.exec(
        `UPDATE providers SET last_verified_at=? WHERE id=?`,
        Date.now(),
        id,
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  activateProvider(id: string): void {
    const rows = [
      ...this.sql.exec(`SELECT id FROM providers WHERE id = ?`, id),
    ] as Array<{ id: string }>;
    if (!rows.length) throw new Error("Provider 不存在");
    // DO 单线程，天然原子：全表置 0 → 该行置 1
    this.sql.exec(`UPDATE providers SET is_active = 0 WHERE is_active = 1`);
    this.sql.exec(`UPDATE providers SET is_active = 1 WHERE id = ?`, id);
  }

  deleteProvider(id: string): { deleted: boolean; reason?: string } {
    const refs = [
      ...this.sql.exec(`SELECT COUNT(*) AS c FROM outbox WHERE provider_id = ?`, id),
    ] as Array<{ c: number }>;
    if ((refs[0]?.c ?? 0) > 0) {
      return { deleted: false, reason: "存在 outbox 引用，禁止删除" };
    }
    this.sql.exec(`DELETE FROM providers WHERE id = ?`, id);
    return { deleted: true };
  }

  // ─── 规则管理 ───
  listRules(q: PageQuery): Page<Rule> {
    const totalRow = [
      ...this.sql.exec(`SELECT COUNT(*) AS c FROM rules`),
    ] as Array<{ c: number }>;
    const total = totalRow[0]?.c ?? 0;
    const items = [
      ...this.sql.exec(
        `SELECT * FROM rules ORDER BY id DESC LIMIT ? OFFSET ?`,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ),
    ] as unknown as Rule[];
    return buildPage(items, total, q);
  }

  upsertRule(input: UpsertRuleInput): { id: string } {
    const id = input.id ?? ulid();
    this.sql.exec(
      `INSERT INTO rules (id, kind, pattern, action, enabled) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, pattern=excluded.pattern,
         action=excluded.action, enabled=excluded.enabled`,
      id,
      input.kind,
      input.pattern,
      input.action,
      input.enabled ? 1 : 0,
    );
    return { id };
  }

  deleteRule(id: string): void {
    this.sql.exec(`DELETE FROM rules WHERE id = ?`, id);
  }

  // ─── 转发规则管理 ───
  listForwardRules(q: PageQuery): Page<ForwardRule> {
    const totalRow = [
      ...this.sql.exec(`SELECT COUNT(*) AS c FROM forward_rules`),
    ] as Array<{ c: number }>;
    const total = totalRow[0]?.c ?? 0;
    const items = [
      ...this.sql.exec(
        `SELECT * FROM forward_rules ORDER BY id DESC LIMIT ? OFFSET ?`,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ),
    ] as unknown as ForwardRule[];
    return buildPage(items, total, q);
  }

  upsertForwardRule(input: UpsertForwardRuleInput): { id: string } {
    const id = input.id ?? ulid();
    const now = Date.now();
    // ON CONFLICT 不更新 created_at，编辑时保留原始创建时间
    this.sql.exec(
      `INSERT INTO forward_rules (id, match_from, match_to, target, keep_original, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET match_from=excluded.match_from, match_to=excluded.match_to,
         target=excluded.target, keep_original=excluded.keep_original, enabled=excluded.enabled`,
      id,
      input.matchFrom ?? null,
      input.matchTo ?? null,
      input.target,
      input.keepOriginal ? 1 : 0,
      input.enabled ? 1 : 0,
      now,
    );
    return { id };
  }

  deleteForwardRule(id: string): void {
    this.sql.exec(`DELETE FROM forward_rules WHERE id = ?`, id);
  }

  // ─── 登录暴力破解防护 ───
  checkLogin(ip: string): LoginCheckResult {
    const rows = [
      ...this.sql.exec(`SELECT locked_until FROM login_attempts WHERE ip = ?`, ip),
    ] as Array<{ locked_until: number | null }>;
    const lockedUntil = rows.length ? rows[0].locked_until : null;
    if (lockedUntil && lockedUntil > Date.now()) {
      return { locked: true, lockedUntil };
    }
    return { locked: false };
  }

  recordLoginResult(ip: string, success: boolean): void {
    if (success) {
      this.sql.exec(`DELETE FROM login_attempts WHERE ip = ?`, ip);
      return;
    }
    const maxFails = getConfigInt(this.doCtx(), "login_max_fails");
    const lockSeconds = getConfigInt(this.doCtx(), "login_lock_seconds");
    const rows = [
      ...this.sql.exec(`SELECT fail_count FROM login_attempts WHERE ip = ?`, ip),
    ] as Array<{ fail_count: number | null }>;
    const failCount = (rows.length ? rows[0].fail_count ?? 0 : 0) + 1;
    const lockedUntil = failCount >= maxFails ? Date.now() + lockSeconds * 1000 : null;
    this.sql.exec(
      `INSERT INTO login_attempts (ip, fail_count, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, locked_until=excluded.locked_until`,
      ip,
      failCount,
      lockedUntil,
    );
  }

  // ─── 管理密码（哈希在 DO 内计算，明文不出 DO）───
  hasPassword(): boolean {
    return getConfig(this.doCtx(), "admin_password_hash") != null;
  }

  // 首次引导设置初始密码：仅当尚无密码时可用
  async setupPassword(plain: string): Promise<{ ok: boolean; error?: string }> {
    if (this.hasPassword()) return { ok: false, error: "已初始化，禁止重复设置" };
    if (!plain || plain.length < 6) return { ok: false, error: "密码至少 6 位" };
    setConfig(this.doCtx(), "admin_password_hash", await hashPassword(plain));
    return { ok: true };
  }

  async verifyLoginPassword(plain: string): Promise<boolean> {
    const stored = getConfig(this.doCtx(), "admin_password_hash");
    if (!stored) return false;
    return verifyPassword(plain, stored);
  }

  async changePassword(
    oldPlain: string,
    newPlain: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const stored = getConfig(this.doCtx(), "admin_password_hash");
    if (!stored) return { ok: false, error: "尚未设置密码" };
    if (!(await verifyPassword(oldPlain, stored))) {
      return { ok: false, error: "原密码错误" };
    }
    if (!newPlain || newPlain.length < 6) return { ok: false, error: "新密码至少 6 位" };
    setConfig(this.doCtx(), "admin_password_hash", await hashPassword(newPlain));
    return { ok: true };
  }

  // ─── 设置（不含密码）───
  getPrimaryDomain(): string {
    return getConfig(this.doCtx(), "primary_domain") ?? "";
  }

  getSettings(): SettingsDTO {
    const c = this.doCtx();
    return {
      primaryDomain: getConfig(c, "primary_domain") ?? "",
      loginMaxFails: getConfigInt(c, "login_max_fails"),
      loginLockSeconds: getConfigInt(c, "login_lock_seconds"),
      dailySendLimit: getConfigInt(c, "daily_send_limit"),
      bodyInlineMax: getConfigInt(c, "body_inline_max"),
      maxMailSize: getConfigInt(c, "max_mail_size"),
    };
  }

  updateSettings(input: UpdateSettingsInput): void {
    const c = this.doCtx();
    if (input.primaryDomain !== undefined) {
      setConfig(c, "primary_domain", input.primaryDomain.trim());
    }
    if (input.loginMaxFails !== undefined) {
      setConfig(c, "login_max_fails", String(input.loginMaxFails));
    }
    if (input.loginLockSeconds !== undefined) {
      setConfig(c, "login_lock_seconds", String(input.loginLockSeconds));
    }
    if (input.dailySendLimit !== undefined) {
      setConfig(c, "daily_send_limit", String(input.dailySendLimit));
    }
    if (input.bodyInlineMax !== undefined) {
      setConfig(c, "body_inline_max", String(input.bodyInlineMax));
    }
    if (input.maxMailSize !== undefined) {
      setConfig(c, "max_mail_size", String(input.maxMailSize));
    }
  }

  // ─── 邮件操作（已读 / 移动 / 删除）───
  setRead(id: string, read: boolean): void {
    this.sql.exec(`UPDATE mails SET is_read = ? WHERE id = ?`, read ? 1 : 0, id);
  }

  moveMail(id: string, folder: string): void {
    this.sql.exec(`UPDATE mails SET folder = ? WHERE id = ?`, folder, id);
  }

  // 当前 folder：用于 api 层决定「删除」是移入废纸篓还是永久删除
  getFolder(id: string): string | null {
    const rows = [
      ...this.sql.exec(`SELECT folder FROM mails WHERE id = ?`, id),
    ] as Array<{ folder: string }>;
    return rows.length ? rows[0].folder : null;
  }

  // 永久删除：清理 R2（附件 / 外置正文 / 原始 .eml）后删表行
  async purgeMail(id: string): Promise<void> {
    const mailRows = [
      ...this.sql.exec(
        `SELECT body_r2_key, raw_r2_key FROM mails WHERE id = ?`,
        id,
      ),
    ] as Array<{ body_r2_key: string | null; raw_r2_key: string | null }>;
    if (!mailRows.length) return;
    const attRows = [
      ...this.sql.exec(`SELECT r2_key FROM attachments WHERE mail_id = ?`, id),
    ] as Array<{ r2_key: string }>;

    const keys = [
      mailRows[0].body_r2_key,
      mailRows[0].raw_r2_key,
      ...attRows.map((a) => a.r2_key),
    ].filter((k): k is string => !!k);
    for (const key of keys) {
      await this.env.MAIL_R2.delete(key);
    }

    this.sql.exec(`DELETE FROM attachments WHERE mail_id = ?`, id);
    this.sql.exec(`DELETE FROM outbox WHERE mail_id = ?`, id);
    this.sql.exec(`DELETE FROM mails WHERE id = ?`, id);
  }

  // 失败/排队的出站邮件手动重试
  async retrySend(mailId: string, origin?: string): Promise<SendResultDTO> {
    return doRetryOutbox(this.doCtx(), mailId, origin);
  }

  // ─── 通讯录 ───
  listContacts(q: PageQuery): Page<Contact> {
    return doListContacts(this.doCtx(), q);
  }

  upsertContact(input: UpsertContactInput): { id: string } {
    return doUpsertContact(this.doCtx(), input);
  }

  deleteContact(id: string): void {
    doDeleteContact(this.doCtx(), id);
  }
}

// ─── 辅助 ───
function maskSecrets(
  config: Record<string, string>,
  schema: { key: string; secret?: boolean }[],
): Record<string, string> {
  const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = secretKeys.has(k) && v ? SECRET_MASK : v;
  }
  return out;
}

function mergeConfig(
  existing: Record<string, string>,
  incoming: Record<string, string>,
  schema: { key: string; secret?: boolean }[],
): Record<string, string> {
  const secretKeys = new Set(schema.filter((f) => f.secret).map((f) => f.key));
  const merged: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    // secret 字段留空或仍为打码占位 → 保留旧值
    if (secretKeys.has(k) && (v === "" || v === SECRET_MASK)) continue;
    merged[k] = v;
  }
  return merged;
}

function validateRequired(
  schema: { key: string; required?: boolean; label: string }[],
  config: Record<string, string>,
): void {
  for (const f of schema) {
    if (f.required && !config[f.key]) {
      throw new Error(`缺少必填配置: ${f.label}`);
    }
  }
}
