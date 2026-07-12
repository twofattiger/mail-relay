// blob 存储抽象：屏蔽 R2 / DO-SQLite 差异。
// 接口刻意对齐 R2 语义的最小子集，使 R2 实现是零成本包装。

export interface BlobPutOptions {
  /** 内容类型；null/undefined = 未知 */
  contentType?: string | null;
}

/**
 * 只读 blob 句柄。语义对齐 R2ObjectBody：
 * body / arrayBuffer() / text() 三者只能消费其一，且只能消费一次。
 */
export interface BlobObject {
  readonly size: number;
  readonly contentType: string | null;
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface BlobStore {
  /** 覆盖写（同 key 幂等） */
  put(
    key: string,
    // ⚠️ 类型联合刻意【不包含】ReadableStream —— 这是防回归的结构性约束，不是遗漏。
    //    历史 bug：FixedLengthStream + 流式 put，实际字节数 ≠ message.rawSize
    //    → put 永不 resolve → handleEmail 挂起 → SMTP 无 250 → 发件方无限重投。
    //    所有 value 必须是长度已确定的内存对象。要加流式支持前先读 §6.5。
    value: ArrayBuffer | ArrayBufferView | string,
    opts?: BlobPutOptions,
  ): Promise<void>;

  /** 不存在返回 null */
  get(key: string): Promise<BlobObject | null>;

  /** 不存在也视为成功（幂等） */
  delete(key: string): Promise<void>;
}
