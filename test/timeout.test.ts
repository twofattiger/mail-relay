import { describe, it, expect } from "vitest";
import { withTimeout } from "../src/shared/timeout";

// SMTP 关键路径护栏：任何 await 的最坏结果必须是"快速失败"而非"挂起"。
// 这条直接复现原 bug 的失败模式（put 永不 resolve → 挂起）。
describe("withTimeout（SMTP 关键路径护栏）", () => {
  it("永不 resolve 的 promise 在阈值内抛超时错误", async () => {
    const never = new Promise<void>(() => {}); // 永不 resolve，模拟挂起的 blob put
    await expect(withTimeout(never, 50, "raw blob 落盘")).rejects.toThrow(/超时/);
  });

  it("按时完成的 promise 正常返回，不受影响", async () => {
    const fast = Promise.resolve(42);
    await expect(withTimeout(fast, 1000, "x")).resolves.toBe(42);
  });

  it("在超时前完成的慢 promise 也能正常返回", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("ok"), 20));
    await expect(withTimeout(slow, 500, "x")).resolves.toBe("ok");
  });
});
