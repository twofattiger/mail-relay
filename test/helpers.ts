import { registry } from "../src/providers/registry";
import { ProviderError, type ProviderDef } from "../src/providers/types";

// 模块级可变状态：控制 mock provider 的行为（send 结果 / verify 结果）。
// DO 与测试运行在同一 workerd 隔离区，共享模块单例，故 DO 内的 mock 会读到这里的改动。
export const mockState = {
  mode: "ok" as "ok" | "retry" | "fail",
  sendCalls: 0,
  lastMail: null as unknown,
  verifyOk: true,
};

export function resetMock() {
  mockState.mode = "ok";
  mockState.sendCalls = 0;
  mockState.lastMail = null;
  mockState.verifyOk = true;
}

const mockDef: ProviderDef = {
  type: "mock",
  displayName: "Mock",
  configSchema: [{ key: "note", label: "备注" }],
  create: () => ({
    type: "mock",
    async send(mail) {
      mockState.sendCalls++;
      mockState.lastMail = mail;
      if (mockState.mode === "retry")
        throw new ProviderError("mock 临时错误", true);
      if (mockState.mode === "fail")
        throw new ProviderError("mock 永久错误", false);
      return { providerMessageId: "mock-" + mockState.sendCalls };
    },
    async verifyConfig() {
      if (!mockState.verifyOk) throw new ProviderError("mock 验证失败", false);
    },
  }),
};

export function registerMockProvider() {
  registry.set("mock", mockDef);
}

// 构造最小 RFC822 邮件
export function buildEml(opts: {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from ?? "Alice <alice@example.com>"}`);
  lines.push(`To: ${opts.to ?? "me@mydomain.com"}`);
  lines.push(`Subject: ${opts.subject ?? "Hello"}`);
  if (opts.messageId) lines.push(`Message-ID: ${opts.messageId}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  if (opts.html) {
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: text/html; charset=utf-8`);
    lines.push("");
    lines.push(opts.html);
  } else {
    lines.push(`Content-Type: text/plain; charset=utf-8`);
    lines.push("");
    lines.push(opts.text ?? "Hello body");
  }
  return lines.join("\r\n");
}
