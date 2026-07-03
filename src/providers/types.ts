// 领域层只认识这些类型，不认识任何具体厂商。

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>; // In-Reply-To / References / Message-ID
  attachments?: OutgoingAttachment[];
}

export interface OutgoingAttachment {
  filename: string;
  content?: string; // base64
  url?: string; // 短时效签名 URL，由不支持 url 的 provider 内部自行下载
  contentType?: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface MailProvider {
  readonly type: string;
  send(mail: OutgoingMail): Promise<SendResult>; // 失败抛 ProviderError{retryable}
  verifyConfig(): Promise<void>; // 后台"测试连接"
}

// 配置元数据 → 后台动态渲染表单，新增 provider 零前端改动
export interface ConfigField {
  key: string;
  label: string;
  secret?: boolean; // true → 密码框、回显打码
  required?: boolean;
  placeholder?: string;
}

export interface ProviderDef {
  type: string;
  displayName: string;
  configSchema: ConfigField[];
  create(config: Record<string, string>): MailProvider;
}

// 发送编排唯一需要理解的错误分类
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}
