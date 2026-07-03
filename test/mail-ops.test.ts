import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildEml } from "./helpers";

let mb: ReturnType<typeof env.MAILBOX.getByName>;
beforeEach(() => {
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

async function ingestOne() {
  const key = `raw/test/${crypto.randomUUID()}.eml`;
  const eml = buildEml({ messageId: `<${crypto.randomUUID()}@x.com>` });
  await env.MAIL_R2.put(key, eml);
  const r = await mb.ingest({
    r2Key: key,
    envelopeFrom: "alice@example.com",
    envelopeTo: "me@mydomain.com",
    size: eml.length,
  });
  return { mailId: r.mailId, key };
}

async function isReadInList(mailId: string): Promise<number> {
  const page = await mb.listMails({ page: 1, pageSize: 50, folder: "inbox" });
  return page.items.find((x) => x.id === mailId)?.is_read ?? -1;
}

describe("邮件操作", () => {
  it("标记已读 / 未读", async () => {
    const { mailId } = await ingestOne();
    expect(await isReadInList(mailId)).toBe(0);
    await mb.setRead(mailId, true);
    expect(await isReadInList(mailId)).toBe(1);
    await mb.setRead(mailId, false);
    expect(await isReadInList(mailId)).toBe(0);
  });

  it("移动到垃圾邮件 / 收件箱", async () => {
    const { mailId } = await ingestOne();
    await mb.moveMail(mailId, "spam");
    expect(await mb.getFolder(mailId)).toBe("spam");
    await mb.moveMail(mailId, "inbox");
    expect(await mb.getFolder(mailId)).toBe("inbox");
  });

  it("彻底删除清理 R2 与表行", async () => {
    const { mailId, key } = await ingestOne();
    await mb.moveMail(mailId, "trash");
    expect(await env.MAIL_R2.get(key)).not.toBeNull();

    await mb.purgeMail(mailId);
    expect(await mb.getFolder(mailId)).toBeNull();
    expect(await env.MAIL_R2.get(key)).toBeNull();
    expect(await mb.getMail(mailId)).toBeNull();
  });
});
