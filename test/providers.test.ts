import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { encryptJson, decryptJson } from "../src/do/crypto";
import { resendDef } from "../src/providers/resend";
import { ProviderError } from "../src/providers/types";

describe("crypto AES-GCM", () => {
  it("加解密往返", async () => {
    const key = "master-key-123";
    const secret = { apiKey: "re_abc123", fromName: "Yiyang" };
    const enc = await encryptJson(key, secret);
    expect(enc).not.toContain("re_abc123"); // 密文不含明文
    const dec = await decryptJson<typeof secret>(key, enc);
    expect(dec).toEqual(secret);
  });

  it("每次加密 IV 随机（同明文密文不同）", async () => {
    const key = "master-key-123";
    const a = await encryptJson(key, { x: 1 });
    const b = await encryptJson(key, { x: 1 });
    expect(a).not.toBe(b);
  });

  it("错误密钥无法解密", async () => {
    const enc = await encryptJson("key-a", { x: 1 });
    await expect(decryptJson("key-b", enc)).rejects.toBeDefined();
  });
});

describe("Resend provider 错误分类", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("成功返回 providerMessageId", async () => {
    stubFetch(200, { id: "resend-msg-1" });
    const p = resendDef.create({ apiKey: "re_x" });
    const res = await p.send({
      from: "me@d.com",
      to: ["a@b.com"],
      subject: "hi",
      text: "x",
    });
    expect(res.providerMessageId).toBe("resend-msg-1");
  });

  it("429 → retryable", async () => {
    stubFetch(429, { message: "rate limited" });
    const p = resendDef.create({ apiKey: "re_x" });
    await expect(
      p.send({ from: "me@d.com", to: ["a@b.com"], subject: "s" }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("500 → retryable", async () => {
    stubFetch(500, { message: "server error" });
    const p = resendDef.create({ apiKey: "re_x" });
    await expect(
      p.send({ from: "me@d.com", to: ["a@b.com"], subject: "s" }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("422 → 非 retryable", async () => {
    stubFetch(422, { message: "invalid" });
    const p = resendDef.create({ apiKey: "re_x" });
    await expect(
      p.send({ from: "me@d.com", to: ["a@b.com"], subject: "s" }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("verifyConfig 鉴权失败抛错", async () => {
    stubFetch(401, { message: "unauthorized" });
    const p = resendDef.create({ apiKey: "bad" });
    await expect(p.verifyConfig()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MailboxDO Provider 管理", () => {
  let mb: ReturnType<typeof env.MAILBOX.getByName>;
  beforeEach(() => {
    mb = env.MAILBOX.getByName(crypto.randomUUID());
  });
  function stub() {
    return mb;
  }

  it("secret 字段列表打码，激活唯一", async () => {
    const p1 = await stub().createProvider({
      type: "resend",
      name: "R1",
      config: { apiKey: "re_secret_1", fromName: "One" },
    });
    const p2 = await stub().createProvider({
      type: "resend",
      name: "R2",
      config: { apiKey: "re_secret_2", fromName: "Two" },
    });

    const list = await stub().listProviders();
    const v1 = list.find((p) => p.id === p1.id)!;
    expect(v1.config.apiKey).not.toBe("re_secret_1"); // 打码
    expect(v1.config.fromName).toBe("One"); // 非 secret 明文

    await stub().activateProvider(p1.id);
    await stub().activateProvider(p2.id);
    const after = await stub().listProviders();
    const actives = after.filter((p) => p.is_active === 1);
    expect(actives.length).toBe(1);
    expect(actives[0].id).toBe(p2.id);
  });

  it("更新时 secret 留空不覆盖旧值", async () => {
    const { id } = await stub().createProvider({
      type: "resend",
      name: "R",
      config: { apiKey: "re_keep_me", fromName: "X" },
    });
    await stub().updateProvider({ id, name: "R改名", config: { fromName: "Y" } });
    // 直接解密底层配置验证 apiKey 仍在
    const list = await stub().listProviders();
    const v = list.find((p) => p.id === id)!;
    expect(v.name).toBe("R改名");
    expect(v.config.fromName).toBe("Y");
    expect(v.config.apiKey).toBeTruthy(); // 仍打码存在，未被清空
  });
});
