// 无依赖 ULID 实现：48 位时间戳 + 80 位随机，Crockford Base32 编码，字典序即时间序
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RAND_LEN; i++) {
    out += ENCODING[bytes[i] % 32];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
