import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // 测试期注入的 secrets/vars（真实部署走 wrangler secret put）
        bindings: {
          CONFIG_MASTER_KEY: "test-master-key-0123456789abcdef",
          SESSION_SECRET: "test-session-secret-abcdef0123456789",
          // 明文管理员密码
          ADMIN_PASSWORD: "test-password",
          DAILY_SEND_LIMIT: "100",
          BODY_INLINE_MAX: "262144",
          LOGIN_MAX_FAILS: "5",
          LOGIN_LOCK_SECONDS: "900",
        },
      },
    }),
  ],
});
