import type { Env, UpsertForwardRuleInput } from "../shared/types";
import { error, json, parsePageQuery } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

export async function listForwardRules(req: Request, env: Env): Promise<Response> {
  const q = parsePageQuery(new URL(req.url));
  return json(await stubOf(env).listForwardRules(q));
}

export async function upsertForwardRule(
  req: Request,
  env: Env,
  id?: string,
): Promise<Response> {
  let body: Partial<UpsertForwardRuleInput>;
  try {
    body = (await req.json()) as Partial<UpsertForwardRuleInput>;
  } catch {
    return error(400, "请求体格式错误");
  }
  const target = body.target?.trim();
  if (!target) return error(400, "缺少转发目标地址");
  const matchFrom = body.matchFrom?.trim();
  const matchTo = body.matchTo?.trim();
  // 防误配全量转发：发件人与收件人匹配至少填一项
  if (!matchFrom && !matchTo) {
    return error(400, "发件人与收件人匹配至少填写一项");
  }
  const res = await stubOf(env).upsertForwardRule({
    id: id ?? body.id,
    matchFrom: matchFrom || undefined,
    matchTo: matchTo || undefined,
    target,
    keepOriginal: body.keepOriginal ?? true,
    enabled: body.enabled ?? true,
  });
  return json(res);
}

export async function deleteForwardRule(env: Env, id: string): Promise<Response> {
  await stubOf(env).deleteForwardRule(id);
  return json({ ok: true });
}
