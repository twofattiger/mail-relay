import PostalMime from "postal-mime";

export interface ParsedAttachment {
  filename: string;
  mimeType: string | null;
  content: Uint8Array;
  size: number;
}

export interface ParsedMail {
  messageId: string | null;
  from: string; // 规范化后的头部 From（含显示名时保留）
  fromAddr: string; // 纯地址（小写）
  to: string; // 逗号拼接的收件人（展示）
  subject: string | null;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string | null;
  snippet: string;
  attachments: ParsedAttachment[];
}

const SNIPPET_LEN = 200;

export async function parseEml(raw: ArrayBuffer | Uint8Array): Promise<ParsedMail> {
  const parsed = await PostalMime.parse(raw);

  const fromAddr = normalizeAddr(parsed.from?.address ?? "");
  const from = formatAddress(parsed.from?.name, parsed.from?.address) || fromAddr;
  const to = (parsed.to ?? [])
    .map((a) => formatAddress(a.name, a.address))
    .filter(Boolean)
    .join(", ");

  const text = parsed.text ?? null;
  const html = parsed.html ?? null;

  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((a) => {
    const content = toUint8(a.content);
    return {
      filename: a.filename || "attachment",
      mimeType: a.mimeType ?? null,
      content,
      size: content.byteLength,
    };
  });

  return {
    messageId: normalizeMessageId(parsed.messageId),
    from,
    fromAddr,
    to,
    subject: parsed.subject ?? null,
    text,
    html,
    inReplyTo: normalizeMessageId(parsed.inReplyTo),
    references: parsed.references ?? null,
    snippet: makeSnippet(text, html),
    attachments,
  };
}

// 从 References 头 / In-Reply-To 头里抽出全部 message-id（含尖括号规范化）
export function extractRefIds(
  inReplyTo: string | null,
  references: string | null,
): string[] {
  const ids = new Set<string>();
  for (const src of [inReplyTo, references]) {
    if (!src) continue;
    const matches = src.match(/<[^>]+>/g);
    if (matches) {
      for (const m of matches) ids.add(m);
    } else {
      const t = src.trim();
      if (t) ids.add(ensureAngle(t));
    }
  }
  return [...ids];
}

function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = id.match(/<[^>]+>/);
  if (m) return m[0];
  return ensureAngle(id.trim());
}

function ensureAngle(id: string): string {
  if (id.startsWith("<") && id.endsWith(">")) return id;
  return `<${id.replace(/^<|>$/g, "")}>`;
}

function normalizeAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

function formatAddress(name?: string, address?: string): string {
  if (!address) return name ?? "";
  if (name && name !== address) return `${name} <${address}>`;
  return address;
}

function makeSnippet(text: string | null, html: string | null): string {
  let src = text ?? "";
  if (!src && html) src = stripHtml(html);
  return src.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function toUint8(content: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // base64 字符串
  const bin = atob(content as string);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
