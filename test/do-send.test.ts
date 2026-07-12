import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { MailboxDO } from "../src/do/mailbox";
import { registerMockProvider, resetMock, mockState, testBlob } from "./helpers";

let mb: ReturnType<typeof env.MAILBOX.getByName>;
function stub() {
  return mb;
}

async function setupActiveMock() {
  const { id } = await stub().createProvider({
    type: "mock",
    name: "Mock 主通道",
    config: { note: "test" },
  });
  await stub().activateProvider(id);
  return id;
}

beforeAll(() => {
  registerMockProvider();
});
beforeEach(() => {
  resetMock();
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

describe("MailboxDO.send", () => {
  it("无激活 provider 时报错", async () => {
    // 直接在实例内调用，使拒绝在同一隔离区被完整消费（避免 RPC 远端未处理拒绝噪声）
    await runInDurableObject(stub(), async (inst: MailboxDO) => {
      await expect(
        inst.send({ to: ["x@y.com"], from: "me@mydomain.com", subject: "hi" }),
      ).rejects.toThrow("没有激活");
    });
  });

  it("成功发送：outbox=sent，配额 +1", async () => {
    await setupActiveMock();
    mockState.mode = "ok";
    const res = await stub().send({
      to: ["bob@example.com"],
      from: "me@mydomain.com",
      subject: "你好",
      text: "正文",
    });
    expect(res.status).toBe("sent");
    const ob = await stub().getOutbox(res.outboxId);
    expect(ob!.status).toBe("sent");
    expect(ob!.provider_msg_id).toBeTruthy();
    expect(mockState.sendCalls).toBe(1);
  });

  it("可重试失败：outbox 保持 queued，attempt+1，排 next_retry_at", async () => {
    await setupActiveMock();
    mockState.mode = "retry";
    const res = await stub().send({
      to: ["bob@example.com"],
      from: "me@mydomain.com",
      subject: "重试",
    });
    expect(res.status).toBe("queued");
    const ob = await stub().getOutbox(res.outboxId);
    expect(ob!.status).toBe("queued");
    expect(ob!.attempt).toBe(1);
    expect(ob!.next_retry_at).toBeTruthy();
  });

  it("不可重试失败：outbox=failed", async () => {
    await setupActiveMock();
    mockState.mode = "fail";
    const res = await stub().send({
      to: ["bob@example.com"],
      from: "me@mydomain.com",
      subject: "永久失败",
    });
    expect(res.status).toBe("failed");
    const ob = await stub().getOutbox(res.outboxId);
    expect(ob!.status).toBe("failed");
  });

  it("回复继承线程与 In-Reply-To 头", async () => {
    await setupActiveMock();
    mockState.mode = "ok";
    // 先造一封入站原件
    const key = `raw/test/${crypto.randomUUID()}.eml`;
    const eml = [
      "From: alice@example.com",
      "To: me@mydomain.com",
      "Subject: 原始话题",
      "Message-ID: <orig@example.com>",
      "",
      "hi",
    ].join("\r\n");
    await testBlob(env, stub()).put(key, eml, { contentType: "message/rfc822" });
    const ing = await stub().ingest({
      r2Key: key,
      envelopeFrom: "alice@example.com",
      envelopeTo: "me@mydomain.com",
      size: eml.length,
    });
    const orig = await stub().getMail(ing.mailId);

    const res = await stub().send({
      to: ["alice@example.com"],
      from: "me@mydomain.com",
      subject: "",
      text: "回复内容",
      replyToMailId: ing.mailId,
    });
    const outMail = await stub().getMail(res.mailId);
    expect(outMail!.thread_id).toBe(orig!.thread_id);
    expect(outMail!.in_reply_to).toBe("<orig@example.com>");
    const sent = mockState.lastMail as { headers: Record<string, string> };
    expect(sent.headers["In-Reply-To"]).toBe("<orig@example.com>");
  });

  it("alarm 重发到期项：queued→sent", async () => {
    await setupActiveMock();
    mockState.mode = "retry";
    const res = await stub().send({
      to: ["bob@example.com"],
      from: "me@mydomain.com",
      subject: "待重试",
      text: "body",
    });
    expect(res.status).toBe("queued");

    // 把 next_retry_at 拨到过去，并让 mock 转为成功
    mockState.mode = "ok";
    await runInDurableObject(stub(), async (inst: MailboxDO, state) => {
      state.storage.sql.exec(
        `UPDATE outbox SET next_retry_at = 1 WHERE id = ?`,
        res.outboxId,
      );
      await inst.alarm(); // 直接调用实例方法（alarm 不能走 RPC）
    });

    const ob = await stub().getOutbox(res.outboxId);
    expect(ob!.status).toBe("sent");
  });

  it("超过最大重试次数转 failed", async () => {
    await setupActiveMock();
    mockState.mode = "retry";
    const res = await stub().send({
      to: ["bob@example.com"],
      from: "me@mydomain.com",
      subject: "屡试屡败",
      text: "body",
    });
    // 反复把重试时间拨到过去并触发 alarm，直至转 failed（上限 5 次）
    for (let i = 0; i < 6; i++) {
      await runInDurableObject(stub(), async (inst: MailboxDO, state) => {
        state.storage.sql.exec(
          `UPDATE outbox SET next_retry_at = 1 WHERE id = ? AND status = 'queued'`,
          res.outboxId,
        );
        await inst.alarm();
      });
    }
    const ob = await stub().getOutbox(res.outboxId);
    expect(ob!.status).toBe("failed");
    expect(ob!.attempt).toBeGreaterThanOrEqual(5);
  });
});
