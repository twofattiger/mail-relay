import type { Env, UpdateSettingsInput } from "../shared/types";
import { error, json } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

// 正文外置阈值上限（字节）：DO SQLite 单行 2MB 硬限，封顶 1MB 留余量
export const BODY_INLINE_MAX_LIMIT = 1024 * 1024;

// 收信大小上限（字节）：Cloudflare Email Routing 单封邮件硬上限 25MB
export const MAX_MAIL_SIZE_LIMIT = 25 * 1024 * 1024;

// 域名格式校验：多级标签 + 至少 2 位字母 TLD，总长 ≤253（空字符串表示未设置，单独放行）
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

export async function getSettings(env: Env): Promise<Response> {
  return json(await stubOf(env).getSettings());
}

export async function updateSettings(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return error(400, "请求体格式错误");
  }

  const input: UpdateSettingsInput = {};
  if (typeof body.primaryDomain === "string") {
    const domain = body.primaryDomain.trim().toLowerCase();
    if (domain && !isValidDomain(domain)) {
      return error(400, "主域名格式不正确，例如 yourdomain.com");
    }
    input.primaryDomain = domain;
  }
  for (const key of [
    "loginMaxFails",
    "loginLockSeconds",
    "dailySendLimit",
    "bodyInlineMax",
    "maxMailSize",
  ] as const) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n <= 0) {
        return error(400, `配置项 ${key} 必须为正整数`);
      }
      input[key] = Math.floor(n);
    }
  }

  // 正文外置阈值上限：Durable Object SQLite 单行上限 2MB，内联正文需给其它列留余量，故封顶 1MB
  if (input.bodyInlineMax !== undefined && input.bodyInlineMax > BODY_INLINE_MAX_LIMIT) {
    return error(400, `正文外置阈值不能超过 ${BODY_INLINE_MAX_LIMIT} 字节（1MB）`);
  }

  // 收信大小上限：不能超过 Cloudflare Email Routing 的邮件硬上限 25MB
  if (input.maxMailSize !== undefined && input.maxMailSize > MAX_MAIL_SIZE_LIMIT) {
    return error(400, `最大收信大小不能超过 ${MAX_MAIL_SIZE_LIMIT} 字节（25MB）`);
  }

  await stubOf(env).updateSettings(input);
  return json({ ok: true });
}

export async function changePassword(req: Request, env: Env): Promise<Response> {
  let body: { oldPassword?: string; newPassword?: string };
  try {
    body = (await req.json()) as { oldPassword?: string; newPassword?: string };
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.oldPassword || !body.newPassword) {
    return error(400, "缺少原密码或新密码");
  }
  const res = await stubOf(env).changePassword(body.oldPassword, body.newPassword);
  if (!res.ok) return error(400, res.error ?? "修改失败");
  return json({ ok: true });
}
