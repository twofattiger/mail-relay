import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// DO SQLite 模式测试：真实还原"未绑定 R2"的部署形态。
// 与 vitest.config.ts（R2 模式）共用同一套用例，验证 blob 路径在两种模式下都通。
export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // 不提供 r2Buckets —— 真实还原"未绑定 R2"的部署形态。
        bindings: {
          CONFIG_MASTER_KEY: "test-master-key-0123456789abcdef",
          SESSION_SECRET: "test-session-secret-abcdef0123456789",
          DATA_DURABLE_MODE: "0", // DO SQLite 模式
        },
      },
    }),
  ],
});
