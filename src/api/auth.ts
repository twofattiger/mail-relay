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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
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

  const hash = await sha256Hex(body.password);
  const ok = hash === env.ADMIN_PASSWORD_HASH;
  await stub.recordLoginResult(ip, ok);
  if (!ok) return error(401, "口令错误");

  const token = await makeToken(env.SESSION_SECRET, {
    sub: "admin",
    exp: Date.now() + SESSION_TTL_MS,
  } satisfies SessionPayload);

  const cookie = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ");

  return json({ ok: true }, { headers: { "set-cookie": cookie } });
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
