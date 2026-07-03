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

  // Cloudflare Email Routing 在将流传递给 worker 时就已经能获知 rawSize。
  // 若包含大附件超出系统/平台限制（例如超过 25MB），可直接在此处阻断，不进入后续 RPC 和处理。
  const MAX_SIZE = 25 * 1024 * 1024;
  if (size > MAX_SIZE) {
    message.setReject("Message too large (exceeds 25MB)");
    return;
  }

  // 邮件头 From/To 供转发规则匹配：message.headers 已就绪，不消费 raw 流、不做完整 MIME 解析
  const headerFrom = message.headers.get("from") ?? undefined;
  const headerTo = message.headers.get("to") ?? undefined;

  // 1. precheck：毫秒级 RPC 查 rules（拒收）+ 转发规则（邮件头匹配）
  const v = await stub.precheck({
    envelopeFrom,
    to: envelopeTo,
    size,
    headerFrom,
    headerTo,
  });
  if (v.reject) {
    message.setReject(v.reason ?? "Rejected");
    return;
  }

  // 2. 转发：在读取 raw 流之前调用 message.forward（forward 不消费用户侧 raw 流）。
  //    环路保护：本系统转发出去的信带 X-Forwarded-By，若又流回则不再转发、强制存档。
  const alreadyForwarded = message.headers.has("x-forwarded-by");
  if (!alreadyForwarded && v.forwards?.length) {
    const forwardOk = await forwardAll(message, v.forwards);
    // 转发后不存档：仅当全部转发成功才丢弃；任一失败回退存档保底（不丢信）
    if (v.keepOriginal === false && forwardOk) return;
  }

  // 3. 读流（只能读一次）
  // 按照“接收带附件邮件时传输中断”问题解决方案，注释掉在内存中组装全量数组的逻辑
  // const raw = new Uint8Array(await streamToArrayBuffer(message.raw, size));

  // 4. 返回 250 前同步落 R2 保底（投递责任转移点）
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const mailKey = crypto.randomUUID();
  const r2Key = `raw/${yyyy}/${mm}/${mailKey}.eml`;
  // 直接将流传递给 R2 避免内存溢出与 CPU 超限
  await env.MAIL_R2.put(r2Key, message.raw);

  // 5. 异步解析入库（即使失败，raw 已在 R2，可事后补索引）
  ctx.waitUntil(stub.ingest({ r2Key, envelopeFrom, envelopeTo, size }));
}

// 转发到全部目标（可多次调用 forward 投递到多个地址）；全部成功返回 true，
// 任一失败返回 false（失败仅记日志、不抛出，避免影响收信落库）。
async function forwardAll(
  message: ForwardableEmailMessage,
  targets: string[],
): Promise<boolean> {
  const headers = new Headers({ "X-Forwarded-By": "mail-relay" });
  let ok = true;
  for (const target of targets) {
    try {
      await message.forward(target, headers);
    } catch (e) {
      ok = false;
      console.error(
        `forward to ${target} failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return ok;
}

// 因处理大附件时会导致 10ms CPU 时间超限和 128MB 内存超限，引起连接断开和无休止重投。
// 已按方案一改为直接向 R2 写入 ReadableStream，此函数暂时注释保留，不予删除。
/*
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
*/
