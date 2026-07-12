import type { MailboxDO } from "../do/mailbox";
import type { BlobObject, BlobPutOptions, BlobStore } from "./types";

/** DO 内部 blob 端点前缀。仅经 stub.fetch 访问，不暴露到公网。 */
export const BLOB_PATH_PREFIX = "/__blob/";

// stub.fetch 需要一个合法 URL；host 任意，DO 不做校验。
const BASE = `https://mailbox.internal${BLOB_PATH_PREFIX}`;

/**
 * Worker 侧代理：DO 模式下把 blob 读写转发进 DO。
 * 用 fetch 而非 RPC，理由：
 *   1. 原生双向流式，下载大附件时 Worker 内存不驻留整份数据；
 *   2. 不受 RPC 参数序列化体积影响（上传上限 25MB）；
 *   3. 完全不改动 MailboxDO 现有 RPC 方法签名。
 */
export class DoProxyBlobStore implements BlobStore {
  constructor(private readonly stub: DurableObjectStub<MailboxDO>) {}

  private url(key: string): string {
    return BASE + encodeURIComponent(key);
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    opts?: BlobPutOptions,
  ): Promise<void> {
    const headers = new Headers();
    if (opts?.contentType) headers.set("x-blob-content-type", opts.contentType);

    const res = await this.stub.fetch(this.url(key), {
      method: "PUT",
      headers,
      body: value as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`blob put 失败 (${res.status}): ${await res.text()}`);
    }
  }

  async get(key: string): Promise<BlobObject | null> {
    const res = await this.stub.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`blob get 失败 (${res.status}): ${await res.text()}`);
    }
    return {
      size: Number(res.headers.get("x-blob-size") ?? 0),
      contentType: res.headers.get("x-blob-content-type"),
      body: res.body as ReadableStream<Uint8Array>,
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.stub.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`blob delete 失败 (${res.status})`);
    }
  }
}
