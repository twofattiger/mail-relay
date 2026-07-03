import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { MailboxDO } from "../src/do/mailbox";
import { registerMockProvider, resetMock, mockState } from "./helpers";

let mb: ReturnType<typeof env.MAILBOX.getByName>;

beforeAll(() => {
  registerMockProvider();
});
beforeEach(() => {
  resetMock();
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

async function activeMock() {
  const { id } = await mb.createProvider({ type: "mock", name: "M", config: { note: "t" } });
  await mb.activateProvider(id);
}

async function putPending(name: string, body: string) {
  const key = `pending/${crypto.randomUUID()}/${name}`;
  await env.MAIL_R2.put(key, new TextEncoder().encode(body));
  return key;
}

describe("附件收发", () => {
  it("pending 附件发送后落库、转正式区、pending 清除、provider 收到内联", async () => {
    await activeMock();
    mockState.mode = "ok";
    const key = await putPending("hello.txt", "hi there");

    const res = await mb.send({
      to: ["b@x.com"],
      from: "me@mydomain.com",
      subject: "s",
      text: "body",
      pendingAttachments: [{ key, filename: "hello.txt", size: 8, mimeType: "text/plain" }],
    });
    expect(res.status).toBe("sent");

    // pending 已迁移删除
    expect(await env.MAIL_R2.get(key)).toBeNull();

    // 邮件详情含附件，且正式 R2 对象存在
    const m = await mb.getMail(res.mailId);
    expect(m!.attachments.length).toBe(1);
    expect(m!.attachments[0].filename).toBe("hello.txt");
    expect(await env.MAIL_R2.get(m!.attachments[0].r2_key)).not.toBeNull();

    // provider 收到内联 base64 附件
    const sent = mockState.lastMail as { attachments: Array<{ content?: string }> };
    expect(sent.attachments.length).toBe(1);
    expect(sent.attachments[0].content).toBeTruthy();
  });

  it("重试保留附件（修复丢附件）", async () => {
    await activeMock();
    mockState.mode = "retry";
    const key = await putPending("a.bin", "data");

    const res = await mb.send({
      to: ["b@x.com"],
      from: "me@mydomain.com",
      subject: "s",
      text: "b",
      pendingAttachments: [{ key, filename: "a.bin", size: 4, mimeType: null }],
    });
    expect(res.status).toBe("queued");

    // 拨到期 + 转成功后触发 alarm 重发
    mockState.mode = "ok";
    await runInDurableObject(mb, async (inst: MailboxDO, state) => {
      state.storage.sql.exec(`UPDATE outbox SET next_retry_at = 1 WHERE id = ?`, res.outboxId);
      await inst.alarm();
    });

    const ob = await mb.getOutbox(res.outboxId);
    expect(ob!.status).toBe("sent");
    // 重试仍带附件
    const sent = mockState.lastMail as { attachments: Array<unknown> };
    expect(sent.attachments.length).toBe(1);
  });

  it("手动 retrySend 对失败邮件重发成功", async () => {
    await activeMock();
    mockState.mode = "fail";
    const res = await mb.send({
      to: ["b@x.com"],
      from: "me@mydomain.com",
      subject: "s",
      text: "b",
    });
    expect(res.status).toBe("failed");

    mockState.mode = "ok";
    const retry = await mb.retrySend(res.mailId);
    expect(retry.status).toBe("sent");
    const ob = await mb.getOutbox(res.outboxId);
    expect(ob!.status).toBe("sent");
  });

  it("彻底删除邮件时一并清理附件的 R2 对象", async () => {
    await activeMock();
    mockState.mode = "ok";
    const key = await putPending("del.txt", "bye");
    const res = await mb.send({
      to: ["b@x.com"],
      from: "me@mydomain.com",
      subject: "s",
      text: "b",
      pendingAttachments: [{ key, filename: "del.txt", size: 3, mimeType: "text/plain" }],
    });
    const m = await mb.getMail(res.mailId);
    const attKey = m!.attachments[0].r2_key;
    expect(await env.MAIL_R2.get(attKey)).not.toBeNull();

    await mb.purgeMail(res.mailId);
    // 附件的 R2 对象与邮件记录都应被清理
    expect(await env.MAIL_R2.get(attKey)).toBeNull();
    expect(await mb.getMail(res.mailId)).toBeNull();
  });
});
