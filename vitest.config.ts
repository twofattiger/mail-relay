import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // 测试期注入的 secrets（真实部署走 wrangler secret put）。
        // 业务配置（密码、防爆破、配额、阈值）已迁入 DO config 表，测试用例自行 setup。
        bindings: {
          CONFIG_MASTER_KEY: "test-master-key-0123456789abcdef",
          SESSION_SECRET: "test-session-secret-abcdef0123456789",
        },
      },
    }),
  ],
});
