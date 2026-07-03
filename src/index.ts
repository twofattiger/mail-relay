// 唯一入口：只做分发，不含业务。
import type { Env } from "./shared/types";
import { handleEmail } from "./ingest/handler";
import { handleFetch } from "./api/router";

export { MailboxDO } from "./do/mailbox";

export default {
  email: handleEmail,
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
