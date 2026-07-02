import type { Page, PageQuery } from "./types";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

// 统一分页参数解析（§8.3）：page 默认 1，pageSize 默认 20、硬上限 100
export function parsePageQuery(url: URL): PageQuery {
  const page = Math.max(1, toInt(url.searchParams.get("page"), 1));
  const rawSize = toInt(url.searchParams.get("pageSize"), PAGE_SIZE_DEFAULT);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, rawSize));
  const q = url.searchParams.get("q") ?? undefined;
  const folder = (url.searchParams.get("folder") as PageQuery["folder"]) ?? undefined;
  return { page, pageSize, q, folder };
}

function toInt(v: string | null, fallback: number): number {
  if (v == null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// 统一分页响应组装（§8.3）
export function buildPage<T>(items: T[], total: number, q: PageQuery): Page<T> {
  return {
    items,
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export function offset(q: PageQuery): number {
  return (q.page - 1) * q.pageSize;
}
