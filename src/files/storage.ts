/** PB tools/filesystem: where uploaded files live, keyed "<collectionId>/<recordId>/<filename>". */
export interface StoredFile {
  data: Uint8Array<ArrayBuffer>;
  /** The type the client sent with the upload; empty when unknown. */
  type: string;
}

export interface Storage {
  put(key: string, file: StoredFile): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
  /** Removes every key under prefix (a record's directory). */
  deletePrefix(prefix: string): Promise<void>;
}

/** Process memory; the default, so tests and dbs without a data dir need no disk. */
export class MemoryStorage implements Storage {
  readonly files: Map<string, StoredFile> = new Map();
  put(key: string, file: StoredFile): Promise<void> {
    this.files.set(key, file);
    return Promise.resolve();
  }
  get(key: string): Promise<StoredFile | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
  deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
    return Promise.resolve();
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

/** pb_data/storage on disk, PB's local filesystem. The client's type is kept in a sidecar "<file>.attrs". */
export class FsStorage implements Storage {
  constructor(readonly root: string) {}
  #path(key: string) {
    return `${this.root}/${safe(key)}`;
  }
  async put(key: string, file: StoredFile): Promise<void> {
    const path = this.#path(key);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, file.data);
    await Deno.writeTextFile(`${path}.attrs`, JSON.stringify({ type: file.type }));
  }
  async get(key: string): Promise<StoredFile | null> {
    const path = this.#path(key);
    try {
      const data = await Deno.readFile(path);
      let type = "";
      try {
        type = JSON.parse(await Deno.readTextFile(`${path}.attrs`)).type ?? "";
      } catch { /* no attrs: type stays unknown */ }
      return { data, type };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    const path = this.#path(key);
    for (const p of [path, `${path}.attrs`]) await Deno.remove(p).catch(() => {});
  }
  async deletePrefix(prefix: string): Promise<void> {
    await Deno.remove(this.#path(prefix.replace(/\/$/, "")), { recursive: true }).catch(() => {});
  }
}
