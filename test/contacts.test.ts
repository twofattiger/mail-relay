import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { MailboxDO } from "../src/do/mailbox";
import { parseAddress } from "../src/do/contacts";
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

describe("parseAddress", () => {
  it("解析显示名与纯地址、统一小写", () => {
    expect(parseAddress("Alice <Alice@Example.com>")).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(parseAddress("bob@x.com")).toEqual({ name: "", email: "bob@x.com" });
    expect(parseAddress('"Carol Ng" <carol@x.com>')).toEqual({
      name: "Carol Ng",
      email: "carol@x.com",
    });
  });
});

describe("通讯录", () => {
  it("upsert 去重（邮箱为准）、非空名字才覆盖", async () => {
    const a = await mb.upsertContact({ email: "x@y.com", name: "老王" });
    const b = await mb.upsertContact({ email: "X@Y.com", name: "" }); // 大小写等价、空名不覆盖
    expect(b.id).toBe(a.id);
    const list = await mb.listContacts({ page: 1, pageSize: 20 });
    expect(list.total).toBe(1);
    expect(list.items[0].name).toBe("老王");
    expect(list.items[0].email).toBe("x@y.com");

    await mb.upsertContact({ email: "x@y.com", name: "小王" }); // 非空名覆盖
    const list2 = await mb.listContacts({ page: 1, pageSize: 20 });
    expect(list2.items[0].name).toBe("小王");
  });

  it("非法邮箱被拒", async () => {
    // 在实例内调用，使拒绝在同一隔离区被完整消费（避免 RPC 远端未处理拒绝噪声）
    await runInDurableObject(mb, async (inst: MailboxDO) => {
      expect(() => inst.upsertContact({ email: "not-an-email", name: "x" })).toThrow();
    });
  });

  it("发送成功后收件人自动入库（不覆盖已有名字）", async () => {
    await activeMock();
    mockState.mode = "ok";
    // 预置一个已命名联系人
    await mb.upsertContact({ email: "bob@example.com", name: "Bob 手动" });

    await mb.send({
      to: ["Bob <bob@example.com>", "New Person <new@example.com>"],
      from: "me@mydomain.com",
      subject: "hi",
      text: "body",
    });

    const list = await mb.listContacts({ page: 1, pageSize: 20 });
    const byEmail = Object.fromEntries(list.items.map((c) => [c.email, c.name]));
    expect(byEmail["bob@example.com"]).toBe("Bob 手动"); // 未被覆盖
    expect(byEmail["new@example.com"]).toBe("New Person"); // 新增
  });

  it("getMail.from_saved 反映通讯录状态", async () => {
    const key = `raw/test/${crypto.randomUUID()}.eml`;
    const eml = [
      "From: Zoe <zoe@example.com>",
      "To: me@mydomain.com",
      "Subject: hi",
      `Message-ID: <${crypto.randomUUID()}@example.com>`,
      "",
      "body",
    ].join("\r\n");
    await env.MAIL_R2.put(key, eml);
    const ing = await mb.ingest({
      r2Key: key,
      envelopeFrom: "zoe@example.com",
      envelopeTo: "me@mydomain.com",
      size: eml.length,
    });

    let m = await mb.getMail(ing.mailId);
    expect(m!.from_saved).toBe(false);

    await mb.upsertContact({ email: "zoe@example.com", name: "Zoe" });
    m = await mb.getMail(ing.mailId);
    expect(m!.from_saved).toBe(true);
  });

  it("删除联系人", async () => {
    const { id } = await mb.upsertContact({ email: "d@x.com", name: "D" });
    await mb.deleteContact(id);
    const list = await mb.listContacts({ page: 1, pageSize: 20 });
    expect(list.total).toBe(0);
  });
});
