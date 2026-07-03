/// <reference types="@cloudflare/vitest-pool-workers/types" />

// 把本项目的绑定类型接入 cloudflare:test 的 env（其类型为 Cloudflare.Env）。
// 本文件不含顶层 import/export，属于 ambient 脚本上下文，命名空间直接全局合并。
declare namespace Cloudflare {
  interface Env {
    MAILBOX: DurableObjectNamespace<import("../src/do/mailbox").MailboxDO>;
    MAIL_R2: R2Bucket;
    ASSETS?: Fetcher;
    CONFIG_MASTER_KEY: string;
    SESSION_SECRET: string;
  }
}
