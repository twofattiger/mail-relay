import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // R2 binding 在此由 miniflare 直接提供，独立于 wrangler.toml：
        // 生产 wrangler.toml 里 [[r2_buckets]] 默认注释掉（DO 模式），
        // 测试仍能本地模拟 R2 来跑 R2 模式用例。
        r2Buckets: ["MAIL_R2"],
        // 测试期注入的 secrets（真实部署走 wrangler secret put）。
        // 业务配置（密码、防爆破、配额、阈值）已迁入 DO config 表，测试用例自行 setup。
        bindings: {
          CONFIG_MASTER_KEY: "test-master-key-0123456789abcdef",
          SESSION_SECRET: "test-session-secret-abcdef0123456789",
          DATA_DURABLE_MODE: "1", // R2 模式
        },
      },
    }),
  ],
});
