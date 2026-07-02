// Provider 配置的 AES-GCM 加解密。密钥从 CONFIG_MASTER_KEY 经 HKDF 派生，不落库。
// 存储格式：base64( iv(12B) || ciphertext )。每条记录独立随机 IV。

const IV_LEN = 12;

async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("mail-relay:provider-config"),
      info: enc.encode("aes-gcm"),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJson(
  masterKey: string,
  value: unknown,
): Promise<string> {
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toBase64(packed);
}

export async function decryptJson<T = unknown>(
  masterKey: string,
  packedB64: string,
): Promise<T> {
  const key = await deriveKey(masterKey);
  const packed = fromBase64(packedB64);
  const iv = packed.slice(0, IV_LEN);
  const ct = packed.slice(IV_LEN);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
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
