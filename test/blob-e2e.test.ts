import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { MailboxDO } from "../src/do/mailbox";
import { testBlob } from "./helpers";

// 端到端 blob 路径：收一封带 2 个附件的 .eml → 列表可见 → 下载附件字节一致
// → 下载 raw 一致 → purge 后 DO 模式下 blobs/blob_chunks 表清空。
// 两套 vitest 配置（R2 / DO 模式）下都应通过。

let mb: ReturnType<typeof env.MAILBOX.getByName>;
beforeEach(() => {
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 构造 multipart/mixed：一段正文 + 两个 base64 附件。附件内容用可预测字节。
function buildEmlWithAttachments(): { eml: string; att1: Uint8Array; att2: Uint8Array } {
  const att1 = new Uint8Array(1500).map((_, i) => (i * 7) & 0xff);
  const att2 = new Uint8Array(900).map((_, i) => (i * 13 + 3) & 0xff);
  const b64 = (u: Uint8Array) => {
    let bin = "";
    for (const c of u) bin += String.fromCharCode(c);
    return btoa(bin);
  };
  const wrap = (s: string) => s.replace(/(.{76})/g, "$1\r\n");
  const boundary = "BOUNDARY123";
  const eml = [
    "From: Alice <alice@example.com>",
    "To: me@mydomain.com",
    "Subject: 带附件",
    "Message-ID: <att-e2e@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello with attachments",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="a1.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="a1.bin"',
    "",
    wrap(b64(att1)),
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="a2.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="a2.bin"',
    "",
    wrap(b64(att2)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { eml, att1, att2 };
}

describe("blob 端到端（附件 / raw / purge）", () => {
  it("收信 → 列表可见 → 附件与 raw 字节一致 → purge 清空", async () => {
    const { eml, att1, att2 } = buildEmlWithAttachments();
    const rawKey = `raw/test/${crypto.randomUUID()}.eml`;
    const rawBytes = new TextEncoder().encode(eml);
    await testBlob(env, mb).put(rawKey, rawBytes, { contentType: "message/rfc822" });

    const res = await mb.ingest({
      r2Key: rawKey,
      envelopeFrom: "alice@example.com",
      envelopeTo: "me@mydomain.com",
      size: rawBytes.byteLength,
    });
    expect(res.needsParse).toBe(false);

    // 列表可见
    const page = await mb.listMails({ page: 1, pageSize: 20, folder: "inbox" });
    expect(page.total).toBe(1);

    // 附件元数据
    const mail = await mb.getMail(res.mailId);
    expect(mail!.attachments.length).toBe(2);
    const byName = Object.fromEntries(mail!.attachments.map((a) => [a.filename, a]));

    // 下载附件字节一致
    const a1 = await testBlob(env, mb).get(byName["a1.bin"].r2_key);
    const a2 = await testBlob(env, mb).get(byName["a2.bin"].r2_key);
    expect(bytesEqual(new Uint8Array(await a1!.arrayBuffer()), att1)).toBe(true);
    expect(bytesEqual(new Uint8Array(await a2!.arrayBuffer()), att2)).toBe(true);

    // 下载 raw 一致
    const rawObj = await testBlob(env, mb).get(rawKey);
    expect(bytesEqual(new Uint8Array(await rawObj!.arrayBuffer()), rawBytes)).toBe(true);

    // purge 后邮件、附件、raw 都清空（raw_r2_key 存的正是 rawKey，一并删除）
    await mb.purgeMail(res.mailId);
    expect(await mb.getMail(res.mailId)).toBeNull();
    expect(await testBlob(env, mb).get(byName["a1.bin"].r2_key)).toBeNull();
    expect(await testBlob(env, mb).get(rawKey)).toBeNull();

    // DO 模式：确认 blobs/blob_chunks 已无该邮件的附件残留行
    await runInDurableObject(mb, async (_inst: MailboxDO, state) => {
      const sql = state.storage.sql;
      const rows = [
        ...sql.exec(
          `SELECT COUNT(*) AS c FROM blobs WHERE key = ? OR key = ?`,
          byName["a1.bin"].r2_key,
          byName["a2.bin"].r2_key,
        ),
      ] as Array<{ c: number }>;
      // R2 模式下 blobs 表恒空（c=0）；DO 模式下 purge 已删除（c=0）。
      expect(rows[0].c).toBe(0);
    });
  });
});
