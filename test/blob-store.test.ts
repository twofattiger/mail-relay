import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { MailboxDO } from "../src/do/mailbox";
import { SqliteBlobStore } from "../src/storage/sqlite";

// SqliteBlobStore 分片逻辑单测（优先级最高，陷阱都藏在这里）。
// 直接操作 DO 的 SqlStorage，与存储模式无关：两套 vitest 配置下都应通过。
const CHUNK_SIZE = 768 * 1024;

let mb: ReturnType<typeof env.MAILBOX.getByName>;
beforeEach(() => {
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

// 在 DO 内跑一段用例，注入基于 state.storage.sql 的 SqliteBlobStore。
async function withStore(
  fn: (store: SqliteBlobStore) => Promise<void>,
): Promise<void> {
  await runInDurableObject(mb, async (_inst: MailboxDO, state) => {
    await fn(new SqliteBlobStore(state.storage.sql));
  });
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 2654435761) & 0xff;
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("SqliteBlobStore 分片存储", () => {
  it("空 blob（0 字节）", async () => {
    await withStore(async (store) => {
      await store.put("k/empty", new Uint8Array(0));
      const obj = await store.get("k/empty");
      expect(obj).not.toBeNull();
      expect(obj!.size).toBe(0);
      const buf = await obj!.arrayBuffer();
      expect(buf.byteLength).toBe(0);
    });
  });

  it("小于 1 片（1KB）往返逐字节相等", async () => {
    await withStore(async (store) => {
      const data = randomBytes(1024);
      await store.put("k/1kb", data);
      const obj = await store.get("k/1kb");
      expect(obj!.size).toBe(1024);
      expect(bytesEqual(new Uint8Array(await obj!.arrayBuffer()), data)).toBe(true);
    });
  });

  it("恰好等于 CHUNK_SIZE → chunk_count 为 1", async () => {
    await withStore(async (store) => {
      const data = randomBytes(CHUNK_SIZE);
      await store.put("k/exact", data);
      const obj = await store.get("k/exact");
      expect(obj!.size).toBe(CHUNK_SIZE);
      expect(bytesEqual(new Uint8Array(await obj!.arrayBuffer()), data)).toBe(true);
    });
  });

  it("CHUNK_SIZE + 1 → 分成 2 片且往返相等", async () => {
    await withStore(async (store) => {
      const data = randomBytes(CHUNK_SIZE + 1);
      await store.put("k/plus1", data);
      const obj = await store.get("k/plus1");
      expect(obj!.size).toBe(CHUNK_SIZE + 1);
      expect(bytesEqual(new Uint8Array(await obj!.arrayBuffer()), data)).toBe(true);
    });
  });

  it("跨多片（3MB）往返逐字节相等（抓 subarray vs slice 的坑）", async () => {
    await withStore(async (store) => {
      const data = randomBytes(3 * 1024 * 1024);
      await store.put("k/3mb", data);
      const obj = await store.get("k/3mb");
      expect(bytesEqual(new Uint8Array(await obj!.arrayBuffer()), data)).toBe(true);
    });
  });

  it("流式读结果 === 一次性读结果", async () => {
    await withStore(async (store) => {
      const data = randomBytes(2 * 1024 * 1024 + 123);
      await store.put("k/stream", data);
      const obj = await store.get("k/stream");
      // 消费 body 流
      const chunks: Uint8Array[] = [];
      const reader = obj!.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const joined = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        joined.set(c, off);
        off += c.byteLength;
      }
      expect(bytesEqual(joined, data)).toBe(true);
    });
  });

  it("覆盖写：长 blob → 短 blob，无残留分片", async () => {
    await withStore(async (store) => {
      const long = randomBytes(3 * 1024 * 1024); // 4 片
      const short = randomBytes(1024); // 1 片
      await store.put("k/over", long);
      await store.put("k/over", short);
      const obj = await store.get("k/over");
      expect(obj!.size).toBe(1024);
      expect(bytesEqual(new Uint8Array(await obj!.arrayBuffer()), short)).toBe(true);
    });
  });

  it("delete 后 get 返回 null", async () => {
    await withStore(async (store) => {
      await store.put("k/del", randomBytes(2048));
      await store.delete("k/del");
      expect(await store.get("k/del")).toBeNull();
    });
  });

  it("contentType=null 往返仍为 null（不被改写成 octet-stream）", async () => {
    await withStore(async (store) => {
      await store.put("k/ct-null", randomBytes(16));
      const obj = await store.get("k/ct-null");
      expect(obj!.contentType).toBeNull();
    });
  });

  it("contentType 指定值往返保持", async () => {
    await withStore(async (store) => {
      await store.put("k/ct", "<b>hi</b>", { contentType: "text/html; charset=utf-8" });
      const obj = await store.get("k/ct");
      expect(obj!.contentType).toBe("text/html; charset=utf-8");
      expect(await obj!.text()).toBe("<b>hi</b>");
    });
  });

  it("人为删掉中间分片后下载：流以 error 中断，不得正常 close", async () => {
    await runInDurableObject(mb, async (_inst: MailboxDO, state) => {
      const sql = state.storage.sql;
      const store = new SqliteBlobStore(sql);
      await store.put("k/broken", randomBytes(2 * 1024 * 1024 + 10)); // ≥3 片
      // 删掉中间一片，但 blobs.chunk_count 仍认为存在
      sql.exec(`DELETE FROM blob_chunks WHERE key = ? AND seq = 1`, "k/broken");
      const obj = await store.get("k/broken");
      const reader = obj!.body.getReader();
      let errored = false;
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        errored = true;
      }
      expect(errored).toBe(true);
    });
  });
});
