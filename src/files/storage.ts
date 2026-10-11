/**
 * PB tools/filesystem: where uploaded files live, keyed "<collectionId>/<recordId>/<filename>".
 * Streaming end to end so a large file never has to sit in memory, whichever backend holds it.
 */

/** What a writer says about a blob besides its bytes. */
export interface BlobMeta {
  /** The type the client sent with the upload; empty when unknown. */
  type: string;
}

export interface BlobInfo {
  key: string;
  size: number;
  /** As stored with the blob; empty when unknown. */
  type: string;
  modified: Date;
}

/** Byte range, both ends inclusive (HTTP semantics); end defaults to the last byte. */
export interface BlobRange {
  start: number;
  end?: number;
}

/** An open blob. size is always the whole blob's, so a ranged read can still answer Content-Range. */
export interface BlobObject extends BlobInfo {
  body: ReadableStream<Uint8Array>;
}

export type BlobBody = ReadableStream<Uint8Array> | Uint8Array;

export interface BlobStore {
  put(key: string, body: BlobBody, meta: BlobMeta): Promise<void>;
  /** null when absent; a range past the end is the caller's to refuse (it has the size from stat). */
  get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null>;
  stat(key: string): Promise<BlobInfo | null>;
  delete(key: string): Promise<void>;
  /** Removes every key under prefix (a record's directory). */
  deletePrefix(prefix: string): Promise<void>;
  /** Every blob whose key starts with prefix, in no promised order. */
  list(prefix: string): AsyncIterable<BlobInfo>;
}

/** Kept so consumers written against the buffer interface keep compiling by name. */
export type Storage = BlobStore;

/** Reads a whole body; for small blobs and tests only. */
export async function readAll(body: BlobBody): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctl) {
      if (bytes.byteLength) ctl.enqueue(bytes);
      ctl.close();
    },
  });
}

function clampRange(size: number, range?: BlobRange): [number, number] {
  if (!range) return [0, size];
  const start = Math.min(Math.max(0, range.start), size);
  const end = Math.min(range.end ?? size - 1, size - 1) + 1;
  return [start, Math.max(start, end)];
}

interface MemoryBlob {
  data: Uint8Array<ArrayBuffer>;
  type: string;
  modified: Date;
}

/** Process memory; the default, so tests and dbs without a data dir need no disk. */
export class MemoryStorage implements BlobStore {
  readonly files: Map<string, MemoryBlob> = new Map();
  async put(key: string, body: BlobBody, meta: BlobMeta): Promise<void> {
    this.files.set(key, { data: await readAll(body), type: meta.type, modified: new Date() });
  }
  #info(key: string, f: MemoryBlob): BlobInfo {
    return { key, size: f.data.byteLength, type: f.type, modified: f.modified };
  }
  get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null> {
    const f = this.files.get(key);
    if (!f) return Promise.resolve(null);
    const [s, e] = clampRange(f.data.byteLength, opts?.range);
    return Promise.resolve({ ...this.#info(key, f), body: streamOf(f.data.subarray(s, e)) });
  }
  stat(key: string): Promise<BlobInfo | null> {
    const f = this.files.get(key);
    return Promise.resolve(f ? this.#info(key, f) : null);
  }
  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
  deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
    return Promise.resolve();
  }
  async *list(prefix: string): AsyncIterable<BlobInfo> {
    // Snapshot so a delete during iteration (a migration) is safe.
    for (const [k, f] of [...this.files]) if (k.startsWith(prefix)) yield this.#info(k, f);
  }
}

/** Keys must be plain relative paths: no "..", no absolute or backslash segments. */
function safe(key: string): string {
  const parts = key.split("/");
  if (!key || key.includes("\\") || parts.some((p) => !p || p === "." || p === "..")) {
    throw new Error(`storage: invalid key ${key}`);
  }
  return key;
}

const ATTRS = ".attrs";

/** Stream of [start, end) of an open file, closing it when done or cancelled. */
function fileSlice(file: Deno.FsFile, start: number, end: number): ReadableStream<Uint8Array> {
  let left = end - start;
  let positioned = false;
  return new ReadableStream({
    type: "bytes",
    async pull(ctl) {
      try {
        if (!positioned) {
          await file.seek(start, Deno.SeekMode.Start);
          positioned = true;
        }
        if (left <= 0) {
          file.close();
          ctl.close();
          return;
        }
        const buf = new Uint8Array(Math.min(left, 64 * 1024));
        const n = await file.read(buf);
        if (n === null || n === 0) {
          file.close();
          ctl.close();
          return;
        }
        left -= n;
        ctl.enqueue(buf.subarray(0, n));
      } catch (e) {
        try {
          file.close();
        } catch { /* already closed */ }
        ctl.error(e);
      }
    },
    cancel() {
      try {
        file.close();
      } catch { /* already closed */ }
    },
  });
}

/**
 * pb_data/storage on disk, PB's local filesystem. The client's type is kept in a sidecar "<file>.attrs"
 * (the same file PB's local driver writes), so a data dir moves between PB and here unchanged.
 */
export class FsStorage implements BlobStore {
  constructor(readonly root: string) {}
  #path(key: string) {
    return `${this.root}/${safe(key)}`;
  }
  async put(key: string, body: BlobBody, meta: BlobMeta): Promise<void> {
    const path = this.#path(key);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    // Written beside and renamed so a reader never sees half a file and a failed upload leaves no trace.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeFile(tmp, body);
      await Deno.writeTextFile(`${path}${ATTRS}`, JSON.stringify({ type: meta.type }));
      await Deno.rename(tmp, path);
    } catch (e) {
      await Deno.remove(tmp).catch(() => {});
      throw e;
    }
  }
  async #type(path: string): Promise<string> {
    try {
      return JSON.parse(await Deno.readTextFile(`${path}${ATTRS}`)).type ?? "";
    } catch {
      return ""; // no attrs: type stays unknown
    }
  }
  async stat(key: string): Promise<BlobInfo | null> {
    const path = this.#path(key);
    try {
      const st = await Deno.stat(path);
      if (!st.isFile) return null;
      return { key, size: st.size, type: await this.#type(path), modified: st.mtime ?? new Date(0) };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }
  async get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null> {
    const path = this.#path(key);
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, { read: true });
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
    try {
      const st = await file.stat();
      if (!st.isFile) {
        file.close();
        return null;
      }
      const [s, e] = clampRange(st.size, opts?.range);
      const type = await this.#type(path);
      return { key, size: st.size, type, modified: st.mtime ?? new Date(0), body: fileSlice(file, s, e) };
    } catch (e) {
      file.close();
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    const path = this.#path(key);
    for (const p of [path, `${path}${ATTRS}`]) await Deno.remove(p).catch(() => {});
  }
  async deletePrefix(prefix: string): Promise<void> {
    await Deno.remove(this.#path(prefix.replace(/\/$/, "")), { recursive: true }).catch(() => {});
  }
  async *list(prefix: string): AsyncIterable<BlobInfo> {
    // Walk from the deepest directory the prefix names, then filter the rest of it as a plain string prefix.
    const cut = prefix.lastIndexOf("/");
    const base = cut < 0 ? "" : prefix.slice(0, cut);
    if (base) safe(base);
    yield* this.#walk(base, prefix);
  }
  async *#walk(dir: string, prefix: string): AsyncIterable<BlobInfo> {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir ? `${this.root}/${dir}` : this.root));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    for (const ent of entries) {
      const key = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isDirectory) {
        if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) yield* this.#walk(key, prefix);
        continue;
      }
      if (!ent.isFile || !key.startsWith(prefix) || key.endsWith(ATTRS) || key.endsWith(".tmp")) continue;
      const info = await this.stat(key);
      if (info) yield info;
    }
  }
}
