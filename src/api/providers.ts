import type {
  CreateProviderInput,
  Env,
  UpdateProviderInput,
} from "../shared/types";
import { error, json } from "../shared/http";

type Stub = DurableObjectStub<import("../do/mailbox").MailboxDO>;
function stubOf(env: Env): Stub {
  return env.MAILBOX.getByName("main");
}

export async function listProviders(env: Env): Promise<Response> {
  return json({ items: await stubOf(env).listProviders() });
}

export async function getSchemas(env: Env): Promise<Response> {
  return json({ items: await stubOf(env).listProviderSchemas() });
}

export async function createProvider(req: Request, env: Env): Promise<Response> {
  let body: Partial<CreateProviderInput>;
  try {
    body = (await req.json()) as Partial<CreateProviderInput>;
  } catch {
    return error(400, "请求体格式错误");
  }
  if (!body.type || !body.name || !body.config) {
    return error(400, "缺少 type / name / config");
  }
  try {
    const res = await stubOf(env).createProvider({
      type: body.type,
      name: body.name,
      config: body.config,
    });
    return json(res, { status: 201 });
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "创建失败");
  }
}

export async function updateProvider(
  req: Request,
  env: Env,
  id: string,
): Promise<Response> {
  let body: Partial<UpdateProviderInput>;
  try {
    body = (await req.json()) as Partial<UpdateProviderInput>;
  } catch {
    return error(400, "请求体格式错误");
  }
  try {
    await stubOf(env).updateProvider({ id, name: body.name, config: body.config });
    return json({ ok: true });
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "更新失败");
  }
}

export async function verifyProvider(env: Env, id: string): Promise<Response> {
  const res = await stubOf(env).verifyProvider(id);
  return json(res, { status: res.ok ? 200 : 400 });
}

export async function activateProvider(env: Env, id: string): Promise<Response> {
  try {
    await stubOf(env).activateProvider(id);
    return json({ ok: true });
  } catch (e) {
    return error(400, e instanceof Error ? e.message : "激活失败");
  }
}

export async function deleteProvider(env: Env, id: string): Promise<Response> {
  const res = await stubOf(env).deleteProvider(id);
  if (!res.deleted) return error(409, res.reason ?? "禁止删除");
  return json({ ok: true });
}
