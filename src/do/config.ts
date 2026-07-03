// 统一配置表读写。所有业务配置（管理密码哈希、主域、登录防爆破、发送/正文阈值）
// 集中存 config 表，取代原先散落的环境变量。DO 单线程，读写免锁。

import type { DoCtx } from "./ingest";

// 配置键与内置默认值（缺省时回退）。admin_password_hash / primary_domain 无默认值。
export const CONFIG_DEFAULTS = {
  login_max_fails: "5",
  login_lock_seconds: "900",
  daily_send_limit: "100",
  body_inline_max: "262144",
} as const;

export type ConfigKey =
  | "admin_password_hash"
  | "primary_domain"
  | keyof typeof CONFIG_DEFAULTS;

export function getConfig(ctx: DoCtx, name: ConfigKey): string | null {
  const rows = [
    ...ctx.sql.exec(`SELECT config_value FROM config WHERE config_name = ?`, name),
  ] as Array<{ config_value: string | null }>;
  return rows.length ? rows[0].config_value : null;
}

export function setConfig(ctx: DoCtx, name: ConfigKey, value: string): void {
  ctx.sql.exec(
    `INSERT INTO config (config_name, config_value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(config_name) DO UPDATE SET config_value = excluded.config_value,
       updated_at = excluded.updated_at`,
    name,
    value,
    Date.now(),
  );
}

// 读整数配置：优先取表值，缺失/非法回退内置默认。
export function getConfigInt(ctx: DoCtx, name: keyof typeof CONFIG_DEFAULTS): number {
  const raw = getConfig(ctx, name) ?? CONFIG_DEFAULTS[name];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : parseInt(CONFIG_DEFAULTS[name], 10);
}
