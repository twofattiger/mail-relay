// 管理密码哈希：WebCrypto PBKDF2-SHA256。存储格式 pbkdf2$<iters>$<saltB64>$<hashB64>。
// 明文密码只在 DO 内参与哈希/校验，不落库、不出 DO。

import { timingSafeEqual } from "./sign";

const ITERATIONS = 100_000;
const SALT_LEN = 16;
const HASH_LEN = 32; // 256 bits

async function pbkdf2(plain: string, salt: Uint8Array, iters: number): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    baseKey,
    HASH_LEN * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await pbkdf2(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1], 10);
  if (!Number.isFinite(iters) || iters <= 0) return false;
  const salt = fromBase64(parts[2]);
  const expected = parts[3];
  const hash = await pbkdf2(plain, salt, iters);
  return timingSafeEqual(toBase64(hash), expected);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
