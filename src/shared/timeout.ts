// SMTP 关键路径护栏：任何 await 都要有上界，最坏结果必须是"快速失败"而非"挂起"。
// 历史 bug：流式 put 永不 resolve → handleEmail 挂起 → SMTP 无 250 → 发件方无限重投。
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} 超时 (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}
