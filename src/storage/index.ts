import type { Env } from "../shared/types";
import type { BlobStore } from "./types";
import { R2BlobStore } from "./r2";
import { SqliteBlobStore } from "./sqlite";
import { DoProxyBlobStore } from "./do-proxy";

export type { BlobObject, BlobPutOptions, BlobStore } from "./types";
export { BLOB_PATH_PREFIX } from "./do-proxy";
export { SqliteBlobStore } from "./sqlite";

/**
 * 存储模式判定 —— 全项目唯一一处。
 * DATA_DURABLE_MODE = "1"        → R2 模式（需绑卡开通 R2 + wrangler.toml 绑定 MAIL_R2）
 * DATA_DURABLE_MODE = "0"/空/未设 → DO SQLite 模式（默认，无需绑卡）
 */
export function isR2Mode(env: Env): boolean {
  return String(env.DATA_DURABLE_MODE ?? "").trim() === "1";
}

function requireR2(env: Env): R2Bucket {
  if (!env.MAIL_R2) {
    throw new Error(
      "配置错误：DATA_DURABLE_MODE=1（R2 模式）但未绑定 MAIL_R2。" +
        "请在 wrangler.toml 取消注释 [[r2_buckets]] 区块，" +
        "先执行 `npx wrangler r2 bucket create mail-relay`，再重新部署。",
    );
  }
  return env.MAIL_R2;
}

/** Worker 上下文（api/ 与 ingest/）用。 */
export function workerBlobStore(env: Env): BlobStore {
  if (isR2Mode(env)) return new R2BlobStore(requireR2(env));
  return new DoProxyBlobStore(env.MAILBOX.getByName("main"));
}

/** DO 上下文用。sql 来自 state.storage.sql。 */
export function doBlobStore(env: Env, sql: SqlStorage): BlobStore {
  if (isR2Mode(env)) return new R2BlobStore(requireR2(env));
  return new SqliteBlobStore(sql);
}
