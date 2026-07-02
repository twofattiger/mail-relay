import type { Env, UpsertRuleInput } from "../shared/types";
import { error, json, parsePageQuery } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

export async function listRules(req: Request, env: Env): Promise<Response> {
  const q = parsePageQuery(new URL(req.url));
  return json(await stubOf(env).listRules(q));
}

export async function upsertRule(req: Request, env: Env, id?: string): Promise<Response> {
  let body: Partial<UpsertRuleInput>;
  try {
    body = (await req.json()) as Partial<UpsertRuleInput>;
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.kind || !body.pattern || !body.action) {
    return error(400, "缺少 kind / pattern / action");
  }
  const res = await stubOf(env).upsertRule({
    id: id ?? body.id,
    kind: body.kind,
    pattern: body.pattern,
    action: body.action,
    enabled: body.enabled ?? true,
  });
  return json(res);
}

export async function deleteRule(env: Env, id: string): Promise<Response> {
  await stubOf(env).deleteRule(id);
  return json({ ok: true });
}
