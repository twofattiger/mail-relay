import type { Env } from "../shared/types";
import { error, json } from "../shared/http";
import { makeToken, verifyToken } from "../shared/sign";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const COOKIE_NAME = "mr_session";

interface SessionPayload {
  sub: string;
  exp: number;
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown"
  );
}

// 签发 session cookie（登录与首次设置密码后共用）
async function sessionCookie(env: Env): Promise<string> {
  const token = await makeToken(env.SESSION_SECRET, {
    sub: "admin",
    exp: Date.now() + SESSION_TTL_MS,
  } satisfies SessionPayload);
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ");
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  const stub = env.MAILBOX.getByName("main");

  const lock = await stub.checkLogin(ip);
  if (lock.locked) {
    return error(429, "尝试次数过多，请稍后再试");
  }

  let body: { password?: string };
  try {
    body = (await req.json()) as { password?: string };
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.password) return error(400, "缺少 password");

  // 校验存于 config 表的 PBKDF2 哈希（比对在 DO 内完成，明文不落库）
  const ok = await stub.verifyLoginPassword(body.password);
  await stub.recordLoginResult(ip, ok);
  if (!ok) return error(401, "口令错误");

  return json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env) } });
}

// 首次引导：仅当尚未设置密码时可用，设置初始密码并自动登录
export async function handleSetup(req: Request, env: Env): Promise<Response> {
  const stub = env.MAILBOX.getByName("main");
  let body: { password?: string };
  try {
    body = (await req.json()) as { password?: string };
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.password) return error(400, "缺少 password");

  const res = await stub.setupPassword(body.password);
  if (!res.ok) return error(400, res.error ?? "设置失败");

  return json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env) } });
}

export function handleLogout(): Response {
  const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return json({ ok: true }, { headers: { "set-cookie": cookie } });
}

// session 校验：合法返回 true
export async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const payload = await verifyToken<SessionPayload>(env.SESSION_SECRET, token);
  if (!payload) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  return payload.sub === "admin";
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
