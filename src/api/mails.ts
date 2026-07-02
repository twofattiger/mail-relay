import type { Env } from "../shared/types";
import { error, json, parsePageQuery } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;

function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

export async function listMails(req: Request, env: Env): Promise<Response> {
  const q = parsePageQuery(new URL(req.url));
  const page = await stubOf(env).listMails(q);
  return json(page);
}

export async function getMail(env: Env, id: string): Promise<Response> {
  const mail = await stubOf(env).getMail(id);
  if (!mail) return error(404, "邮件不存在");
  return json(mail);
}

export async function getThread(env: Env, tid: string): Promise<Response> {
  const mails = await stubOf(env).getThread(tid);
  return json({ items: mails });
}

// 附件下载：鉴权后流式回传 R2
export async function downloadAttachment(env: Env, id: string): Promise<Response> {
  const meta = await stubOf(env).getAttachment(id);
  if (!meta) return error(404, "附件不存在");
  const obj = await env.MAIL_R2.get(meta.r2_key);
  if (!obj) return error(404, "附件内容缺失");
  return streamR2(obj, meta.mime_type, meta.filename);
}

// 下载原始 .eml
export async function downloadRaw(env: Env, mailId: string): Promise<Response> {
  const rawKey = await stubOf(env).getRawKey(mailId);
  if (!rawKey) return error(404, "无原始邮件");
  const obj = await env.MAIL_R2.get(rawKey);
  if (!obj) return error(404, "原始邮件内容缺失");
  return streamR2(obj, "message/rfc822", `${mailId}.eml`);
}

export function streamR2(
  obj: R2ObjectBody,
  contentType: string | null,
  filename: string,
): Response {
  const headers = new Headers();
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  if (obj.size) headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}
