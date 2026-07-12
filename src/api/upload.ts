import type { Env } from "../shared/types";
import { error, json } from "../shared/http";
import { workerBlobStore, isR2Mode } from "../storage";

// R2 模式 25MB；DO 模式收紧到 10MB（DO SQLite Free 档仅 1GB/对象，25MB 单文件压力大）。
const MAX_UPLOAD_R2 = 25 * 1024 * 1024;
const MAX_UPLOAD_DO = 10 * 1024 * 1024;

// 撰写页附件上传：存入 pending 区，返回句柄；发送时再由 DO 转正式区并落库。
export async function handleUpload(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return error(400, "上传格式错误");
  }
  // Workers 运行时的 formData 文件项具备 File 接口，但类型未暴露 File 全局，故结构化断言
  const file = form.get("file") as unknown as
    | { size: number; name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }
    | string
    | null;
  if (!file || typeof file === "string") return error(400, "缺少文件");
  const maxUpload = isR2Mode(env) ? MAX_UPLOAD_R2 : MAX_UPLOAD_DO;
  if (file.size > maxUpload) {
    return error(400, `文件超过 ${Math.round(maxUpload / 1024 / 1024)}MB 上限`);
  }

  const filename = file.name || "attachment";
  const key = `pending/${crypto.randomUUID()}/${sanitize(filename)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await workerBlobStore(env).put(key, bytes, { contentType: file.type || null });

  return json({ key, filename, size: file.size, mimeType: file.type || null });
}

function sanitize(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 128) || "file";
}
