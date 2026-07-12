import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { parsePageQuery, buildPage, PAGE_SIZE_MAX } from "../src/shared/http";
import { buildEml, testBlob } from "./helpers";

describe("分页参数解析（§8.3）", () => {
  it("默认 page=1 pageSize=20", () => {
    const q = parsePageQuery(new URL("https://x/api/mails"));
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
  });

  it("pageSize 硬上限 100", () => {
    const q = parsePageQuery(new URL("https://x/api/mails?pageSize=9999"));
    expect(q.pageSize).toBe(PAGE_SIZE_MAX);
  });

  it("非法值回落默认", () => {
    const q = parsePageQuery(new URL("https://x/api/mails?page=abc&pageSize=-5"));
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(1); // 下限保护
  });

  it("buildPage 结构符合规范", () => {
    const p = buildPage([1, 2], 125, { page: 1, pageSize: 20 });
    expect(p).toMatchObject({
      total: 125,
      page: 1,
      pageSize: 20,
      totalPages: 7,
    });
    expect(p.items.length).toBe(2);
  });
});

describe("listMails 深分页", () => {
  const stub = () => env.MAILBOX.getByName("pagination-fixture");

  it("分页返回正确的总数与页数", async () => {
    // 入库 25 封
    for (let i = 0; i < 25; i++) {
      const eml = buildEml({
        subject: `邮件 ${i}`,
        messageId: `<p${i}@example.com>`,
      });
      const key = `raw/test/${crypto.randomUUID()}.eml`;
      await testBlob(env, stub()).put(key, eml, { contentType: "message/rfc822" });
      await stub().ingest({
        r2Key: key,
        envelopeFrom: "alice@example.com",
        envelopeTo: "me@mydomain.com",
        size: eml.length,
      });
    }
    const page1 = await stub().listMails({ page: 1, pageSize: 20, folder: "inbox" });
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(2);
    expect(page1.items.length).toBe(20);

    const page2 = await stub().listMails({ page: 2, pageSize: 20, folder: "inbox" });
    expect(page2.items.length).toBe(5);
  });
});
