import type { Env } from "../shared/types";
import { error, json } from "../shared/http";
import { verifyR2Token } from "../shared/sign";
import { handleLogin, handleLogout, handleSetup, isAuthed } from "./auth";
import {
  deleteMail,
  downloadAttachment,
  downloadRaw,
  getMail,
  getThread,
  listMails,
  moveMail,
  retryMail,
  setRead,
  streamR2,
} from "./mails";
import { handleSend } from "./send";
import { handleUpload } from "./upload";
import { changePassword, getSettings, updateSettings } from "./settings";
import {
  activateProvider,
  createProvider,
  deleteProvider,
  getSchemas,
  listProviders,
  updateProvider,
  verifyProvider,
} from "./providers";
import { deleteRule, listRules, upsertRule } from "./rules";
import {
  deleteForwardRule,
  listForwardRules,
  upsertForwardRule,
} from "./forward-rules";

export async function handleFetch(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // /r2sign：唯一免 session 路由，靠 HMAC + 时效收口（Provider 拉附件专用）
  if (path.startsWith("/r2sign/")) {
    return handleR2Sign(env, path.slice("/r2sign/".length));
  }

  // 非 API：交回静态资源（[assets] SPA 兜底）。Worker 只处理 /api/*。
  if (!path.startsWith("/api/")) {
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not Found", { status: 404 });
  }

  // 登录 / 登出 / 首次设置 无需已有 session
  if (path === "/api/login" && method === "POST") return handleLogin(req, env);
  if (path === "/api/logout" && method === "POST") return handleLogout();
  if (path === "/api/setup" && method === "POST") return handleSetup(req, env);
  if (path === "/api/session" && method === "GET") {
    const stub = env.MAILBOX.getByName("main");
    const authed = await isAuthed(req, env);
    const needsSetup = !(await stub.hasPassword());
    const primaryDomain = authed ? await stub.getPrimaryDomain() : "";
    return json({ authed, needsSetup, primaryDomain });
  }

  // 其余 /api/* 一律要求鉴权
  if (!(await isAuthed(req, env))) return error(401, "未登录");

  try {
    return await route(req, env, url, method);
  } catch (e) {
    return error(500, e instanceof Error ? e.message : "服务器错误");
  }
}

async function route(
  req: Request,
  env: Env,
  url: URL,
  method: string,
): Promise<Response> {
  const path = url.pathname;
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  // /api/mails ...
  if (path === "/api/mails" && method === "GET") return listMails(req, env);
  if (seg[1] === "mails" && seg[2] && seg[3] === "read" && method === "POST")
    return setRead(req, env, seg[2]);
  if (seg[1] === "mails" && seg[2] && seg[3] === "move" && method === "POST")
    return moveMail(req, env, seg[2]);
  if (seg[1] === "mails" && seg[2] && seg[3] === "retry" && method === "POST")
    return retryMail(req, env, seg[2]);
  if (seg[1] === "mails" && seg[2] && !seg[3] && method === "DELETE")
    return deleteMail(env, seg[2]);
  if (seg[1] === "mails" && seg[2] && method === "GET") return getMail(env, seg[2]);
  if (seg[1] === "threads" && seg[2] && method === "GET") return getThread(env, seg[2]);
  if (seg[1] === "att" && seg[2] && method === "GET")
    return downloadAttachment(env, seg[2]);
  if (seg[1] === "raw" && seg[2] && method === "GET") return downloadRaw(env, seg[2]);

  if (path === "/api/send" && method === "POST") return handleSend(req, env);
  if (path === "/api/upload" && method === "POST") return handleUpload(req, env);

  // /api/settings ...
  if (path === "/api/settings" && method === "GET") return getSettings(env);
  if (path === "/api/settings" && method === "PUT") return updateSettings(req, env);
  if (path === "/api/settings/password" && method === "POST")
    return changePassword(req, env);

  // /api/providers ...
  if (path === "/api/providers/schema" && method === "GET") return getSchemas(env);
  if (path === "/api/providers" && method === "GET") return listProviders(env);
  if (path === "/api/providers" && method === "POST") return createProvider(req, env);
  if (seg[1] === "providers" && seg[2]) {
    const id = seg[2];
    if (seg[3] === "verify" && method === "POST") return verifyProvider(env, id);
    if (seg[3] === "activate" && method === "POST") return activateProvider(env, id);
    if (!seg[3] && method === "PUT") return updateProvider(req, env, id);
    if (!seg[3] && method === "DELETE") return deleteProvider(env, id);
  }

  // /api/rules ...
  if (path === "/api/rules" && method === "GET") return listRules(req, env);
  if (path === "/api/rules" && method === "POST") return upsertRule(req, env);
  if (seg[1] === "rules" && seg[2] && method === "PUT")
    return upsertRule(req, env, seg[2]);
  if (seg[1] === "rules" && seg[2] && method === "DELETE")
    return deleteRule(env, seg[2]);

  // /api/forward-rules ...
  if (path === "/api/forward-rules" && method === "GET")
    return listForwardRules(req, env);
  if (path === "/api/forward-rules" && method === "POST")
    return upsertForwardRule(req, env);
  if (seg[1] === "forward-rules" && seg[2] && method === "PUT")
    return upsertForwardRule(req, env, seg[2]);
  if (seg[1] === "forward-rules" && seg[2] && method === "DELETE")
    return deleteForwardRule(env, seg[2]);

  return error(404, "未找到路由");
}

async function handleR2Sign(env: Env, token: string): Promise<Response> {
  const payload = await verifyR2Token(env.SESSION_SECRET, token);
  if (!payload) return error(403, "签名无效或已过期");
  const stub = env.MAILBOX.getByName("main");
  const meta = await stub.getAttachment(payload.id);
  if (!meta) return error(404, "附件不存在");
  const obj = await env.MAIL_R2.get(meta.r2_key);
  if (!obj) return error(404, "附件内容缺失");
  return streamR2(obj, meta.mime_type, meta.filename);
}
