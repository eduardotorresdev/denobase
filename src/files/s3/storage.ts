/** PB's S3 filesystem as a BlobStore: same keys as on disk, the client's type kept as the object's Content-Type. */
import type { S3Config } from "../../settings/model.ts";
import type { BlobBody, BlobInfo, BlobMeta, BlobObject, BlobRange, BlobStore } from "../storage.ts";
import { md5Base64, S3Client, S3Error, xmlAll, xmlEscape, xmlOne } from "./client.ts";

/** Above this (or when the size is unknown and the stream runs past it) an upload goes multipart, in parts this big. */
export const MULTIPART_THRESHOLD = 8 * 1024 * 1024;

/** DeleteObjects takes at most this many keys per call. */
const DELETE_BATCH = 1000;

/** Reads up to size bytes from r into one buffer; shorter only at the end of the stream. */
async function readChunk(
  r: ReadableStreamDefaultReader<Uint8Array>,
  size: number,
  carry: { rest?: Uint8Array },
): Promise<Uint8Array> {
  const buf = new Uint8Array(size);
  let n = 0;
  if (carry.rest) {
    const take = Math.min(size, carry.rest.byteLength);
    buf.set(carry.rest.subarray(0, take));
    n = take;
    carry.rest = take < carry.rest.byteLength ? carry.rest.subarray(take) : undefined;
  }
  while (n < size) {
    const { done, value } = await r.read();
    if (done) break;
    const take = Math.min(size - n, value.byteLength);
    buf.set(value.subarray(0, take), n);
    n += take;
    if (take < value.byteLength) carry.rest = value.subarray(take);
  }
  return buf.subarray(0, n);
}

function info(key: string, res: Response, size: number): BlobInfo {
  const lm = res.headers.get("last-modified");
  return { key, size, type: res.headers.get("content-type") ?? "", modified: lm ? new Date(lm) : new Date(0) };
}

export class S3Storage implements BlobStore {
  readonly client: S3Client;
  /** Exposed so tests can drive multipart with small bodies; S3 itself needs parts of at least 5MB. */
  partSize = MULTIPART_THRESHOLD;

  constructor(readonly cfg: S3Config, fetcher?: typeof fetch) {
    this.client = new S3Client(cfg, fetcher);
  }

  async put(key: string, body: BlobBody, meta: BlobMeta): Promise<void> {
    const headers = meta.type ? { "content-type": meta.type } : undefined;
    if (body instanceof Uint8Array && body.byteLength <= this.partSize) {
      (await this.client.send({ method: "PUT", key, headers, body })).body?.cancel();
      return;
    }
    const stream = body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]).stream() : body;
    const reader = stream.getReader();
    const carry: { rest?: Uint8Array } = {};
    try {
      const first = await readChunk(reader, this.partSize, carry);
      // Peek one more read: a stream that ends exactly at the threshold still fits one PUT.
      const peek = carry.rest ? { done: false, value: carry.rest } : await reader.read();
      carry.rest = peek.done ? undefined : peek.value;
      if (peek.done) {
        (await this.client.send({ method: "PUT", key, headers, body: first })).body?.cancel();
        return;
      }
      await this.#multipart(key, headers, first, reader, carry);
    } catch (e) {
      await reader.cancel(e).catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
  }

  async #multipart(
    key: string,
    headers: Record<string, string> | undefined,
    first: Uint8Array,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    carry: { rest?: Uint8Array },
  ): Promise<void> {
    const init = await this.client.send({ method: "POST", key, query: [["uploads", ""]], headers });
    const uploadId = xmlOne(await init.text(), "UploadId");
    if (!uploadId) throw new S3Error(500, "InvalidResponse", "CreateMultipartUpload returned no UploadId");
    try {
      const etags: string[] = [];
      let part: Uint8Array = first;
      while (part.byteLength) {
        const res = await this.client.send({
          method: "PUT",
          key,
          query: [["partNumber", String(etags.length + 1)], ["uploadId", uploadId]],
          body: part,
        });
        res.body?.cancel();
        etags.push(res.headers.get("etag") ?? "");
        part = await readChunk(reader, this.partSize, carry);
      }
      const xml = `<CompleteMultipartUpload>${
        etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(e)}</ETag></Part>`).join("")
      }</CompleteMultipartUpload>`;
      const done = await this.client.send({
        method: "POST",
        key,
        query: [["uploadId", uploadId]],
        headers: { "content-type": "application/xml" },
        body: new TextEncoder().encode(xml),
        signBody: true,
      });
      // S3 can answer 200 with an <Error> body when completion fails late.
      const text = await done.text();
      if (/<Error>/.test(text)) {
        throw new S3Error(500, xmlOne(text, "Code") ?? "InternalError", xmlOne(text, "Message") ?? text);
      }
    } catch (e) {
      // Parts of an unfinished upload are billed until aborted: never leave one behind.
      await this.client.send({ method: "DELETE", key, query: [["uploadId", uploadId]] })
        .then((r) => r.body?.cancel(), () => {});
      throw e;
    }
  }

  async get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null> {
    const r = opts?.range;
    const headers = r ? { range: `bytes=${r.start}-${r.end ?? ""}` } : undefined;
    const res = await this.client.send({ method: "GET", key, headers }, [404, 416]);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 416) {
      // A range past the end: the caller decides from the size, so answer an empty body with it.
      await res.body?.cancel();
      const st = await this.stat(key);
      return st ? { ...st, body: new Blob([]).stream() } : null;
    }
    const total = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    const size = Number(total ?? res.headers.get("content-length") ?? 0);
    return { ...info(key, res, size), body: res.body ?? new Blob([]).stream() };
  }

  async stat(key: string): Promise<BlobInfo | null> {
    const res = await this.client.send({ method: "HEAD", key }, [404]);
    await res.body?.cancel();
    if (res.status === 404) return null;
    return info(key, res, Number(res.headers.get("content-length") ?? 0));
  }

  async delete(key: string): Promise<void> {
    // S3 answers 204 for a missing key too; 404 only comes from odd gateways, and absence is the goal anyway.
    (await this.client.send({ method: "DELETE", key }, [404])).body?.cancel();
  }

  async deletePrefix(prefix: string): Promise<void> {
    let batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const xml = `<Delete><Quiet>true</Quiet>${
        batch.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join("")
      }</Delete>`;
      batch = [];
      const body = new TextEncoder().encode(xml);
      const res = await this.client.send({
        method: "POST",
        query: [["delete", ""]],
        headers: { "content-type": "application/xml", "content-md5": md5Base64(body) },
        body,
        signBody: true,
      });
      const text = await res.text();
      const errs = xmlAll(text, "Error");
      if (errs.length) {
        throw new S3Error(500, xmlOne(errs[0], "Code") ?? "DeleteFailed", `${errs.length} key(s) not deleted`);
      }
    };
    // Listed fully first: deleting while paginating would shift the continuation under S3's feet on some servers.
    const keys: string[] = [];
    for await (const o of this.list(prefix)) keys.push(o.key);
    for (const k of keys) {
      batch.push(k);
      if (batch.length >= DELETE_BATCH) await flush();
    }
    await flush();
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    let token: string | undefined;
    do {
      const query: [string, string][] = [["list-type", "2"], ["prefix", prefix]];
      if (token) query.push(["continuation-token", token]);
      const xml = await (await this.client.send({ method: "GET", query })).text();
      for (const c of xmlAll(xml, "Contents")) {
        const key = xmlOne(c, "Key") ?? "";
        // A "directory" placeholder some consoles create is not a blob.
        if (!key || key.endsWith("/")) continue;
        const lm = xmlOne(c, "LastModified");
        // ListObjectsV2 carries no Content-Type; HEAD each would cost a call per blob, so it stays unknown here.
        yield { key, size: Number(xmlOne(c, "Size") ?? 0), type: "", modified: lm ? new Date(lm) : new Date(0) };
      }
      token = xmlOne(xml, "IsTruncated") === "true" ? xmlOne(xml, "NextContinuationToken") : undefined;
    } while (token);
  }
}
