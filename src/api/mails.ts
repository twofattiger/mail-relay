import type { Env } from "../shared/types";
import { error, json, parsePageQuery } from "../shared/http";
import { workerBlobStore, type BlobObject } from "../storage";

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
  const obj = await workerBlobStore(env).get(meta.r2_key);
  if (!obj) return error(404, "附件内容缺失");
  return streamBlob(obj, meta.mime_type, meta.filename);
}

// 标记已读 / 未读
export async function setRead(req: Request, env: Env, id: string): Promise<Response> {
  let body: { read?: boolean };
  try {
    body = (await req.json()) as { read?: boolean };
  } catch {
    body = {};
  }
  await stubOf(env).setRead(id, body.read !== false);
  return json({ ok: true });
}

// 移动到指定文件夹
const MOVABLE_FOLDERS = ["inbox", "spam", "trash"];
export async function moveMail(req: Request, env: Env, id: string): Promise<Response> {
  let body: { folder?: string };
  try {
    body = (await req.json()) as { folder?: string };
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.folder || !MOVABLE_FOLDERS.includes(body.folder)) {
    return error(400, "无效的目标文件夹");
  }
  await stubOf(env).moveMail(id, body.folder);
  return json({ ok: true });
}

// 删除：非废纸篓 → 移入废纸篓；已在废纸篓 → 永久删除（清理 R2）
export async function deleteMail(env: Env, id: string): Promise<Response> {
  const folder = await stubOf(env).getFolder(id);
  if (folder == null) return error(404, "邮件不存在");
  if (folder === "trash") {
    await stubOf(env).purgeMail(id);
    return json({ ok: true, purged: true });
  }
  await stubOf(env).moveMail(id, "trash");
  return json({ ok: true, purged: false });
}

// 手动重试发送失败/排队中的出站邮件
export async function retryMail(req: Request, env: Env, id: string): Promise<Response> {
  const origin = new URL(req.url).origin;
  try {
    const res = await stubOf(env).retrySend(id, origin);
    return json(res);
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "重试失败");
  }
}

// 下载原始 .eml
export async function downloadRaw(env: Env, mailId: string): Promise<Response> {
  const rawKey = await stubOf(env).getRawKey(mailId);
  if (!rawKey) return error(404, "无原始邮件");
  const obj = await workerBlobStore(env).get(rawKey);
  if (!obj) return error(404, "原始邮件内容缺失");
  return streamBlob(obj, "message/rfc822", `${mailId}.eml`);
}

export function streamBlob(
  obj: BlobObject,
  contentType: string | null,
  filename: string,
): Response {
  const headers = new Headers();
  headers.set("content-type", contentType || obj.contentType || "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  if (obj.size) headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}
