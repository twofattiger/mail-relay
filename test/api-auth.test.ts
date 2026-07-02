import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// vitest.config.ts 注入的密码为 "test-password"
const GOOD = "test-password";
const BAD = "wrong-password";

async function login(password: string) {
  return SELF.fetch("https://mr.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("鉴权", () => {
  it("正确口令签发 session cookie", async () => {
    const res = await login(GOOD);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("mr_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("错误口令返回 401", async () => {
    const res = await login(BAD);
    expect(res.status).toBe(401);
  });

  it("未登录访问受保护接口返回 401", async () => {
    const res = await SELF.fetch("https://mr.test/api/mails?folder=inbox");
    expect(res.status).toBe(401);
  });

  it("携带有效 cookie 可访问受保护接口", async () => {
    const loginRes = await login(GOOD);
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await SELF.fetch("https://mr.test/api/mails?folder=inbox", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("连续失败达阈值后锁定（429）", async () => {
    // LOGIN_MAX_FAILS=5：连续 5 次失败后锁定
    for (let i = 0; i < 5; i++) {
      await login(BAD);
    }
    const res = await login(BAD);
    expect(res.status).toBe(429);
  });
});
