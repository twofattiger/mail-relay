import { DurableObject } from "cloudflare:workers";
import type {
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
import { buildPage } from "../shared/http";
import { ulid } from "../shared/ulid";
import { getProviderDef, listProviderDefs } from "../providers/registry";
import { encryptJson, decryptJson } from "./crypto";
import { runMigrations } from "./schema";
import { precheck as doPrecheck, ingest as doIngest, type DoCtx } from "./ingest";
import { send as doSend, runAlarm } from "./send";

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
                (SELECT COUNT(*) FROM attachments a WHERE a.mail_id = m.id) AS has_attachments
         FROM mails m WHERE ${where}
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

    return { ...mail, attachments };
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
    const maxFails = parseInt(this.env.LOGIN_MAX_FAILS ?? "5", 10) || 5;
    const lockSeconds = parseInt(this.env.LOGIN_LOCK_SECONDS ?? "900", 10) || 900;
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
