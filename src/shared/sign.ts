// 通用 HMAC-SHA256 签名工具：用于 session cookie 与 /r2sign 附件令牌。

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacSignHex(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return hex(sig);
}

// 恒定时间比较，防时序侧信道
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── session token：payload = base64url(JSON) . hmac ───
export async function makeToken(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSignHex(secret, body);
  return `${body}.${sig}`;
}

export async function verifyToken<T = Record<string, unknown>>(
  secret: string,
  token: string,
): Promise<T | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSignHex(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(b64urlDecode(body)) as T;
  } catch {
    return null;
  }
}

// ─── R2 附件签名 URL：token 含 attachmentId + 过期时间 ───
export interface R2TokenPayload {
  id: string; // attachment id
  exp: number; // epoch ms
}

export async function makeR2Token(
  secret: string,
  id: string,
  ttlMs: number,
): Promise<string> {
  return makeToken(secret, { id, exp: Date.now() + ttlMs } satisfies R2TokenPayload);
}

export async function verifyR2Token(
  secret: string,
  token: string,
): Promise<R2TokenPayload | null> {
  const payload = await verifyToken<R2TokenPayload>(secret, token);
  if (!payload || typeof payload.exp !== "number" || typeof payload.id !== "string") {
    return null;
  }
  if (Date.now() > payload.exp) return null;
  return payload;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function b64urlEncode(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
