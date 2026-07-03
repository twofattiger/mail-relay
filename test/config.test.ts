import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

let mb: ReturnType<typeof env.MAILBOX.getByName>;
beforeEach(() => {
  mb = env.MAILBOX.getByName(crypto.randomUUID());
});

describe("配置与管理密码", () => {
  it("首次无密码 → setup 后可校验", async () => {
    expect(await mb.hasPassword()).toBe(false);
    const r = await mb.setupPassword("secret123");
    expect(r.ok).toBe(true);
    expect(await mb.hasPassword()).toBe(true);
    expect(await mb.verifyLoginPassword("secret123")).toBe(true);
    expect(await mb.verifyLoginPassword("wrong-pass")).toBe(false);
  });

  it("重复 setup 被拒", async () => {
    await mb.setupPassword("secret123");
    const r = await mb.setupPassword("another123");
    expect(r.ok).toBe(false);
  });

  it("过短密码被拒", async () => {
    const r = await mb.setupPassword("123");
    expect(r.ok).toBe(false);
  });

  it("改密码需校验旧密码", async () => {
    await mb.setupPassword("secret123");
    expect((await mb.changePassword("bad-old", "newpass1")).ok).toBe(false);
    expect((await mb.changePassword("secret123", "newpass1")).ok).toBe(true);
    expect(await mb.verifyLoginPassword("newpass1")).toBe(true);
    expect(await mb.verifyLoginPassword("secret123")).toBe(false);
  });

  it("settings 默认值与更新", async () => {
    const s = await mb.getSettings();
    expect(s.dailySendLimit).toBe(100);
    expect(s.loginMaxFails).toBe(5);
    expect(s.loginLockSeconds).toBe(900);
    expect(s.bodyInlineMax).toBe(262144);
    expect(s.primaryDomain).toBe("");

    await mb.updateSettings({ primaryDomain: "example.com", dailySendLimit: 50 });
    const s2 = await mb.getSettings();
    expect(s2.primaryDomain).toBe("example.com");
    expect(s2.dailySendLimit).toBe(50);
    expect(await mb.getPrimaryDomain()).toBe("example.com");
  });
});
