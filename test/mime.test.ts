import { describe, it, expect } from "vitest";
import { parseEml, extractRefIds } from "../src/mime/parse";
import { buildEml } from "./helpers";

describe("mime/parse", () => {
  it("解析基本头部与正文，规范化地址", async () => {
    const eml = buildEml({
      from: "Alice Example <Alice@Example.COM>",
      to: "me@mydomain.com",
      subject: "测试主题",
      messageId: "<abc123@example.com>",
      text: "这是一封测试邮件的正文内容。",
    });
    const parsed = await parseEml(new TextEncoder().encode(eml));
    expect(parsed.subject).toBe("测试主题");
    expect(parsed.fromAddr).toBe("alice@example.com"); // 规范化小写
    expect(parsed.messageId).toBe("<abc123@example.com>");
    expect(parsed.text).toContain("测试邮件");
    expect(parsed.snippet.length).toBeGreaterThan(0);
    expect(parsed.snippet.length).toBeLessThanOrEqual(200);
  });

  it("HTML 邮件生成 snippet（剥离标签）", async () => {
    const eml = buildEml({
      subject: "HTML",
      html: "<h1>标题</h1><p>正文<b>加粗</b>段落</p>",
    });
    const parsed = await parseEml(new TextEncoder().encode(eml));
    expect(parsed.html).toContain("<h1>");
    expect(parsed.snippet).not.toContain("<");
    expect(parsed.snippet).toContain("标题");
  });

  it("extractRefIds 从 References 抽出全部 message-id", () => {
    const ids = extractRefIds("<a@x>", "<a@x> <b@y> <c@z>");
    expect(ids).toContain("<a@x>");
    expect(ids).toContain("<b@y>");
    expect(ids).toContain("<c@z>");
    expect(ids.length).toBe(3); // 去重
  });
});
