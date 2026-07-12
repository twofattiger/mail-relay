import type { BlobObject, BlobPutOptions, BlobStore } from "./types";

// DO SQLite 单行（含 key + seq + data）硬上限 2 MB。
// 取 768 KB 留足余量：既远离上限，又不至于分片过多（10MB raw → 14 片）。
const CHUNK_SIZE = 768 * 1024;

/**
 * DO SQLite 实现：blob 按分片存入 blob_chunks 表（BLOB 列，非 base64）。
 * 仅可在 DO 内部构造（依赖 ctx.storage.sql）。
 *
 * 平台约束（写这段代码必须知道的）：
 *  - 单行 / 单 BLOB 上限 2 MB      → 必须分片
 *  - SQL 语句文本上限 100 KB       → 二进制必须走 ? 绑定，绝不能拼进 SQL 字符串
 *  - 绑定参数只接受 ArrayBuffer    → 不能直接传 Uint8Array
 *  - 每 DO 存储上限 1 GB(Free) / 10 GB(Paid)
 */
export class SqliteBlobStore implements BlobStore {
  constructor(private readonly sql: SqlStorage) {}

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    opts?: BlobPutOptions,
  ): Promise<void> {
    this.putSync(key, value, opts); // async 签名仅为满足接口
  }

  /**
   * ⚠️ 本方法【不是 async】—— 这是刻意的防回归设计。
   *    非 async 函数体内写 await 直接编译不过，从而保证：
   *      全同步 sql.exec 序列 = DO 隐式单事务 = blobs.size 与 blob_chunks 恒一致
   *    → streamBlob 的 content-length 永远等于实际吐出的字节数 → 下载端不会挂起。
   *    任何人想在这里加 await，请先读 §6.5。
   */
  private putSync(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    opts?: BlobPutOptions,
  ): void {
    const bytes = toBytes(value);
    const total = bytes.byteLength;
    const count = total === 0 ? 0 : Math.ceil(total / CHUNK_SIZE);

    // 覆盖写：先清旧分片。否则旧 blob 更长时会残留尾部分片，
    // 与新 blob 的 chunk_count 不一致 → 读出脏数据。
    this.sql.exec(`DELETE FROM blob_chunks WHERE key = ?`, key);
    this.sql.exec(`DELETE FROM blobs WHERE key = ?`, key);

    for (let i = 0; i < count; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, total);

      // ⚠️ 必须用 slice()（拷贝），不能用 subarray()（视图）。
      //    subarray 返回的 view 其 .buffer 指向【整个原始 buffer】，
      //    直接绑定会把整份数据写进每一个分片 —— 数据量爆炸且读回错乱。
      //    slice() 返回独立 buffer，byteOffset=0，.buffer 即精确分片。
      const chunk = bytes.slice(start, end);

      this.sql.exec(
        `INSERT INTO blob_chunks (key, seq, data) VALUES (?, ?, ?)`,
        key,
        i,
        chunk.buffer as ArrayBuffer,
      );
    }

    this.sql.exec(
      `INSERT INTO blobs (key, size, content_type, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      key,
      total,
      opts?.contentType ?? null,
      count,
      Date.now(),
    );
  }

  async get(key: string): Promise<BlobObject | null> {
    const meta = [
      ...this.sql.exec(
        `SELECT size, content_type, chunk_count FROM blobs WHERE key = ?`,
        key,
      ),
    ] as Array<{ size: number; content_type: string | null; chunk_count: number }>;
    if (!meta.length) return null;

    const { size, content_type, chunk_count } = meta[0];
    const sql = this.sql;

    // 一次性读全（供 arrayBuffer/text）：内存峰值 = blob 大小。
    // 收信 raw 上限 10MB、上传上限 25MB，均远低于 Worker 128MB。
    const readAll = (): ArrayBuffer => {
      const out = new Uint8Array(size);
      let off = 0;
      for (const row of sql.exec(
        `SELECT data FROM blob_chunks WHERE key = ? ORDER BY seq`,
        key,
      )) {
        const part = new Uint8Array((row as { data: ArrayBuffer }).data);
        out.set(part, off);
        off += part.byteLength;
      }
      return out.buffer;
    };

    // 流式读（供下载直传）：内存峰值 = 单分片 768KB。
    let seq = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (seq >= chunk_count) {
          c.close();
          return;
        }
        // 每次只查一片并立即物化为数组。
        // ⚠️ SQL 游标必须在下一次 exec 前消费完，绝不能让游标跨 await 存活。
        const rows = [
          ...sql.exec(
            `SELECT data FROM blob_chunks WHERE key = ? AND seq = ?`,
            key,
            seq,
          ),
        ] as Array<{ data: ArrayBuffer }>;
        if (!rows.length) {
          // ⚠️ 分片缺失必须 c.error()，绝不能 c.close()：
          //    close 会让流"正常"结束但字节数少于 content-length → 客户端一直等。
          c.error(new Error(`blob 分片缺失: ${key}#${seq}`));
          return;
        }
        c.enqueue(new Uint8Array(rows[0].data));
        seq++;
      },
    });

    return {
      size,
      contentType: content_type,
      body,
      arrayBuffer: async () => readAll(),
      text: async () => new TextDecoder().decode(readAll()),
    };
  }

  async delete(key: string): Promise<void> {
    this.sql.exec(`DELETE FROM blob_chunks WHERE key = ?`, key);
    this.sql.exec(`DELETE FROM blobs WHERE key = ?`, key);
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
