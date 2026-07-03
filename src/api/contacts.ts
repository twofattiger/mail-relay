import type { Env, UpsertContactInput } from "../shared/types";
import { error, json, parsePageQuery } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

export async function listContacts(req: Request, env: Env): Promise<Response> {
  const q = parsePageQuery(new URL(req.url));
  return json(await stubOf(env).listContacts(q));
}

export async function upsertContact(
  req: Request,
  env: Env,
  id?: string,
): Promise<Response> {
  let body: Partial<UpsertContactInput>;
  try {
    body = (await req.json()) as Partial<UpsertContactInput>;
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.email) return error(400, "缺少邮箱");
  try {
    const res = await stubOf(env).upsertContact({
      id,
      name: body.name,
      email: body.email,
    });
    return json(res);
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "保存失败");
  }
}

export async function deleteContact(env: Env, id: string): Promise<Response> {
  await stubOf(env).deleteContact(id);
  return json({ ok: true });
}
