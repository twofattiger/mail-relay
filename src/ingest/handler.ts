import type { Env } from "../shared/types";

// email handler：SMTP 会话内决策 + raw 落盘保底 + 通知 DO（§6.1）
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const stub = env.MAILBOX.getByName("main");

  const envelopeFrom = message.from;
  const envelopeTo = message.to;
  const size = message.rawSize;

  // 1. precheck：毫秒级 RPC 查 rules
  const v = await stub.precheck({ envelopeFrom, to: envelopeTo, size });
  if (v.reject) {
    message.setReject(v.reason ?? "Rejected");
    return;
  }

  // 2. 读流（只能读一次）
  const raw = new Uint8Array(await streamToArrayBuffer(message.raw, size));

  // 3. 返回 250 前同步落 R2 保底（投递责任转移点）
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const mailKey = crypto.randomUUID();
  const r2Key = `raw/${yyyy}/${mm}/${mailKey}.eml`;
  await env.MAIL_R2.put(r2Key, raw);

  // 4. 异步解析入库（即使失败，raw 已在 R2，可事后补索引）
  ctx.waitUntil(stub.ingest({ r2Key, envelopeFrom, envelopeTo, size }));
}

async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<ArrayBuffer> {
  const result = new Uint8Array(size);
  let offset = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result.set(value, offset);
    offset += value.length;
  }
  return result.buffer;
}
