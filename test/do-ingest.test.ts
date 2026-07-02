import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildEml } from "./helpers";

// 每个测试用独立 DO 实例，天然隔离存储
let mb: ReturnType<typeof env.MAILBOX.getByName>;
beforeEach(() => {
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});
function stub() {
  return mb;
}

async function ingestEml(eml: string, envelopeFrom = "alice@example.com") {
  const key = `raw/test/${crypto.randomUUID()}.eml`;
  await env.MAIL_R2.put(key, eml);
  return stub().ingest({
    r2Key: key,
    envelopeFrom,
    envelopeTo: "me@mydomain.com",
    size: eml.length,
  });
}

describe("MailboxDO.precheck", () => {
  it("无规则时放行", async () => {
    const r = await stub().precheck({
      envelopeFrom: "x@y.com",
      to: "me@mydomain.com",
      size: 100,
    });
    expect(r.reject).toBe(false);
  });

  it("命中 reject 规则时拒收", async () => {
    await stub().upsertRule({
      kind: "from",
      pattern: "spammer.com",
      action: "reject",
      enabled: true,
    });
    const r = await stub().precheck({
      envelopeFrom: "bad@spammer.com",
      to: "me@mydomain.com",
      size: 100,
    });
    expect(r.reject).toBe(true);
  });
});

describe("MailboxDO.ingest", () => {
  it("正常入库并可在列表查询到", async () => {
    const eml = buildEml({ subject: "第一封", messageId: "<m1@example.com>" });
    const res = await ingestEml(eml);
    expect(res.duplicate).toBe(false);
    expect(res.needsParse).toBe(false);

    const page = await stub().listMails({ page: 1, pageSize: 20, folder: "inbox" });
    expect(page.total).toBe(1);
    expect(page.items[0].subject).toBe("第一封");
  });

  it("同 message_id 重投幂等去重", async () => {
    const eml = buildEml({ subject: "重复", messageId: "<dup@example.com>" });
    const r1 = await ingestEml(eml);
    const r2 = await ingestEml(eml);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.mailId).toBe(r1.mailId);

    const page = await stub().listMails({ page: 1, pageSize: 20, folder: "inbox" });
    expect(page.total).toBe(1);
  });

  it("回复邮件按 In-Reply-To 归并到同线程", async () => {
    const a = buildEml({ subject: "原始", messageId: "<root@example.com>" });
    const ra = await ingestEml(a);
    const b = buildEml({
      subject: "Re: 原始",
      messageId: "<reply@example.com>",
      inReplyTo: "<root@example.com>",
    });
    const rb = await ingestEml(b);

    const mailA = await stub().getMail(ra.mailId);
    const mailB = await stub().getMail(rb.mailId);
    expect(mailB!.thread_id).toBe(mailA!.thread_id);

    const thread = await stub().getThread(mailA!.thread_id);
    expect(thread.length).toBe(2);
  });

  it("超阈值 HTML 正文外置 R2，详情按需拉回", async () => {
    const bigHtml = "<div>" + "x".repeat(300 * 1024) + "</div>"; // >256KB
    const eml = buildEml({
      subject: "大正文",
      messageId: "<big@example.com>",
      html: bigHtml,
    });
    const res = await ingestEml(eml);
    const mail = await stub().getMail(res.mailId);
    // getMail 会把外置正文拉回，故 body_html 非空但 body_r2_key 也记录
    expect(mail!.body_r2_key).toBeTruthy();
    expect(mail!.body_html).toContain("xxxx");
  });

  it("raw 缺失时写 needs_parse 兜底记录", async () => {
    const res = await stub().ingest({
      r2Key: "raw/does-not-exist.eml",
      envelopeFrom: "ghost@example.com",
      envelopeTo: "me@mydomain.com",
      size: 0,
    });
    expect(res.needsParse).toBe(true);
    const mail = await stub().getMail(res.mailId);
    expect(mail!.needs_parse).toBe(1);
  });

  it("命中 spam 规则自动归档到垃圾箱", async () => {
    await stub().upsertRule({
      kind: "subject",
      pattern: "促销",
      action: "spam",
      enabled: true,
    });
    const eml = buildEml({ subject: "限时促销活动", messageId: "<promo@example.com>" });
    const res = await ingestEml(eml);
    const mail = await stub().getMail(res.mailId);
    expect(mail!.folder).toBe("spam");
  });
});
