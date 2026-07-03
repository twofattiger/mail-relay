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

  // 3~4. 返回 250 前，把 raw 流式落 R2 保底（投递责任转移点）。
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const mailKey = crypto.randomUUID();
  const r2Key = `raw/${yyyy}/${mm}/${mailKey}.eml`;

  // 流式把 raw 写入 R2：不在内存里组装整封邮件，CPU 占用极低（纯 I/O 等待，不计入 10ms 预算），
  // 10MB+ 附件也不会内存/CPU 超限。
  //
  // 关键坑点：R2.put 要求 ReadableStream 具有“已知长度”，而 email 的 message.raw 是未知长度的裸流，
  // 直接 put(message.raw) 会抛异常 —— CF 邮件路由端就表现为
  // “upstream worker temporary error: worker script threw an exception”，并让发送方无限重投。
  // 解决：用 FixedLengthStream(size) 包一层（size 来自 message.rawSize），即满足“已知长度”。
  const fixed = new FixedLengthStream(size);
  // 后台把 raw 泵入定长流；勿 await —— 需与下面的 put 并发流动，否则背压互相等待。
  message.raw.pipeTo(fixed.writable).catch(() => {});
  // 必须 await：确保 raw 在返回 250 前完整落盘，且流在 handler 生命周期内被消费完。
  await env.MAIL_R2.put(r2Key, fixed.readable);

  // 5. raw 已完整落盘后，再异步解析入库：
  //    因上面已 await，ingest 从 R2 读 raw 时保证读到完整对象，不会再误判“解析失败”；
  //    解析/入库失败也不影响已返回的 250，可事后据 raw 补索引。
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
