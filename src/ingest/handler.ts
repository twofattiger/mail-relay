import type { Env } from "../shared/types";
import { workerBlobStore } from "../storage";
import { withTimeout } from "../shared/timeout";

// raw 落盘硬超时：DO 模式下这一步是 Worker → stub.fetch → DO SQLite，
// 关键路径任何 await 都要有上界。超时抛错 → Cloudflare 按投递失败处理 →
// 发件方稍后重投（正常 SMTP 语义），远优于挂起拖死 SMTP 会话。
const RAW_PUT_TIMEOUT_MS = 15_000;

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

  // 3~4. 返回 250 前，把 raw 落 R2 保底（投递责任转移点）。
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const mailKey = crypto.randomUUID();
  const r2Key = `raw/${yyyy}/${mm}/${mailKey}.eml`;

  // 用 Response(...).arrayBuffer() 由运行时原生、高效地把整封 raw 读进内存（不是 JS 逐字节拷贝，
  // CPU 开销很低），再整体 put 到 R2。
  //  - 收信大小已由 precheck 限制（默认 ≤10MB），一次性进内存安全（远低于 128MB）。
  //  - 关键：不再用 FixedLengthStream。它要求写入字节数精确等于 message.rawSize，而 SMTP 传输里
  //    实际字节数常与 rawSize 不符（换行规范化/dot-stuffing 等），一旦不符 put 会一直等不到流结束
  //    而挂起 → SMTP 传输中断、发送方重投，且后面的 ingest 根本不会被调用（邮件进不了库）。
  //  - put ArrayBuffer 长度确定、不依赖 rawSize，落盘稳定。
  const raw = await new Response(message.raw).arrayBuffer();
  await withTimeout(
    workerBlobStore(env).put(r2Key, raw, { contentType: "message/rfc822" }),
    RAW_PUT_TIMEOUT_MS,
    "raw blob 落盘",
  );

  // 5. raw 完整落盘后，异步解析入库（失败也不影响已返回的 250，可事后据 raw 补索引）。
  ctx.waitUntil(
    stub.ingest({ r2Key, envelopeFrom, envelopeTo, size: raw.byteLength }),
  );
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
