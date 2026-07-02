import {
  MailProvider,
  OutgoingMail,
  ProviderDef,
  ProviderError,
  SendResult,
} from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_DOMAINS_ENDPOINT = "https://api.resend.com/domains";

class ResendProvider implements MailProvider {
  readonly type = "resend";
  private apiKey: string;
  private fromName: string;

  constructor(cfg: Record<string, string>) {
    this.apiKey = cfg.apiKey ?? "";
    this.fromName = cfg.fromName ?? "";
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    const from = this.formatFrom(mail.from);
    const body: Record<string, unknown> = {
      from,
      to: mail.to,
      subject: mail.subject,
    };
    if (mail.html) body.html = mail.html;
    if (mail.text) body.text = mail.text;
    if (mail.headers && Object.keys(mail.headers).length) {
      body.headers = mail.headers;
    }
    if (mail.attachments?.length) {
      body.attachments = mail.attachments.map((a) => ({
        filename: a.filename,
        ...(a.content ? { content: a.content } : {}),
        ...(a.url ? { path: a.url } : {}),
        ...(a.contentType ? { content_type: a.contentType } : {}),
      }));
    }

    const resp = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw await toProviderError(resp);
    }
    const data = (await resp.json()) as { id?: string };
    if (!data.id) {
      throw new ProviderError("Resend 响应缺少 message id", false);
    }
    return { providerMessageId: data.id };
  }

  async verifyConfig(): Promise<void> {
    // 用 domains 列表接口做轻量鉴权探测：能过鉴权即视为 key 有效
    const resp = await fetch(RESEND_DOMAINS_ENDPOINT, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!resp.ok) {
      throw await toProviderError(resp);
    }
  }

  private formatFrom(from: string): string {
    // 已含显示名（形如 "Name <a@b>"）则原样使用；否则套用配置里的 fromName
    if (from.includes("<") || !this.fromName) return from;
    return `${this.fromName} <${from}>`;
  }
}

async function toProviderError(resp: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const data = (await resp.json()) as { message?: string; error?: string };
    detail = data.message ?? data.error ?? "";
  } catch {
    detail = await resp.text().catch(() => "");
  }
  // 429/5xx → 可重试；其余 4xx → 终态失败
  const retryable = resp.status === 429 || resp.status >= 500;
  return new ProviderError(
    `Resend ${resp.status}: ${detail || resp.statusText}`,
    retryable,
  );
}

export const resendDef: ProviderDef = {
  type: "resend",
  displayName: "Resend",
  configSchema: [
    { key: "apiKey", label: "API Key", secret: true, required: true },
    { key: "fromName", label: "发件人显示名", placeholder: "Yiyang" },
  ],
  create: (cfg) => new ResendProvider(cfg),
};
