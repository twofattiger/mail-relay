import type { BlobObject, BlobPutOptions, BlobStore } from "./types";

/** R2 实现：薄包装，几乎零开销。Worker 与 DO 上下文都可用。 */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    opts?: BlobPutOptions,
  ): Promise<void> {
    await this.bucket.put(key, value as ArrayBuffer | string, {
      httpMetadata: opts?.contentType
        ? { contentType: opts.contentType }
        : undefined,
    });
  }

  async get(key: string): Promise<BlobObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? null,
      body: obj.body,
      arrayBuffer: () => obj.arrayBuffer(),
      text: () => obj.text(),
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
