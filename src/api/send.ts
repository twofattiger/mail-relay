import type { Env, SendInput } from "../shared/types";
import { error, json } from "../shared/http";

export async function handleSend(req: Request, env: Env): Promise<Response> {
  let body: Partial<SendInput>;
  try {
    body = (await req.json()) as Partial<SendInput>;
  } catch {
    return error(400, "请求体格式错误");
  }

  if (!body.to || !Array.isArray(body.to) || body.to.length === 0) {
    return error(400, "缺少收件人 to");
  }
  if (!body.from) return error(400, "缺少发件人 from");
  if (!body.subject && !body.replyToMailId) {
    return error(400, "缺少主题 subject");
  }
  // 基础收件人格式校验（Resend 退信率约束）
  for (const addr of body.to) {
    // 兼容 "Name <email@domain.com>" 格式，提取尖括号内的真实邮箱进行校验
    const match = addr.match(/<([^>]+)>/);
    const rawEmail = match ? match[1].trim() : addr.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail)) {
      return error(400, `收件人地址格式错误: ${addr}`);
    }
  }

  const origin = new URL(req.url).origin;
  try {
    const result = await env.MAILBOX.getByName("main").send({
      to: body.to,
      from: body.from,
      subject: body.subject ?? "",
      html: body.html,
      text: body.text,
      replyToMailId: body.replyToMailId,
      pendingAttachments: body.pendingAttachments,
      origin,
    });
    return json(result);
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "发送失败");
  }
}
