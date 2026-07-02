// Schema 迁移：按 meta.schema_version 顺序执行增量。DO constructor 内 blockConcurrencyWhile 调用。
// 每个迁移是一个纯 SQL 批次；新增改动追加数组元素即可，切勿修改历史元素。

type SqlRunner = SqlStorage;

const MIGRATIONS: string[] = [
  // v1：初始 schema（对应文档 §4.1，body/needs_parse 等按实现补齐）
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS mails (
    id             TEXT PRIMARY KEY,
    direction      TEXT NOT NULL,
    message_id     TEXT UNIQUE,
    thread_id      TEXT NOT NULL,
    from_addr      TEXT NOT NULL,
    envelope_from  TEXT,
    to_addr        TEXT NOT NULL,
    subject        TEXT,
    snippet        TEXT,
    body_text      TEXT,
    body_html      TEXT,
    body_r2_key    TEXT,
    raw_r2_key     TEXT,
    in_reply_to    TEXT,
    refs           TEXT,
    size_bytes     INTEGER,
    is_read        INTEGER DEFAULT 0,
    folder         TEXT DEFAULT 'inbox',
    needs_parse    INTEGER DEFAULT 0,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mails_thread ON mails(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_mails_list   ON mails(folder, created_at DESC);

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    mail_id TEXT NOT NULL REFERENCES mails(id),
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    r2_key TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_att_mail ON attachments(mail_id);

  CREATE TABLE IF NOT EXISTS providers (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,
    name             TEXT NOT NULL,
    config_enc       TEXT NOT NULL,
    is_active        INTEGER DEFAULT 0,
    last_verified_at INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_active ON providers(is_active) WHERE is_active = 1;

  CREATE TABLE IF NOT EXISTS outbox (
    id              TEXT PRIMARY KEY,
    mail_id         TEXT NOT NULL REFERENCES mails(id),
    provider_id     TEXT NOT NULL REFERENCES providers(id),
    provider_msg_id TEXT,
    status          TEXT NOT NULL,
    attempt         INTEGER DEFAULT 0,
    last_error      TEXT,
    next_retry_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(status, next_retry_at);

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    fail_count INTEGER,
    locked_until INTEGER
  );

  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    kind TEXT,
    pattern TEXT,
    action TEXT,
    enabled INTEGER
  );
  `,
];

// 运行迁移：读取当前 schema_version，顺序执行未应用的增量。
export function runMigrations(sql: SqlRunner): void {
  // meta 表可能尚不存在，先保证之
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
  const rows = [
    ...(sql.exec(`SELECT value FROM meta WHERE key = 'schema_version'`) as any),
  ] as Array<{ value: string }>;
  const current = rows.length ? parseInt(rows[0].value, 10) || 0 : 0;

  for (let v = current; v < MIGRATIONS.length; v++) {
    sql.exec(MIGRATIONS[v]);
  }

  if (current < MIGRATIONS.length) {
    sql.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(MIGRATIONS.length),
    );
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
