import type { Env, UpdateSettingsInput } from "../shared/types";
import { error, json } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
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
    input.primaryDomain = body.primaryDomain;
  }
  for (const key of [
    "loginMaxFails",
    "loginLockSeconds",
    "dailySendLimit",
    "bodyInlineMax",
  ] as const) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n <= 0) {
        return error(400, `配置项 ${key} 必须为正整数`);
      }
      input[key] = Math.floor(n);
    }
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
