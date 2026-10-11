import { stamp } from "../core/time.ts";
import { validKey } from "./name.ts";
import { CurrentStorage } from "../files/current.ts";
import { type BlobBody, type BlobObject, type BlobStore, FsStorage } from "../files/storage.ts";
import type { S3Config } from "../settings/model.ts";

export interface BackupInfo {
  key: string;
  size: number;
  modified: string;
}

const ZIP = { type: "application/zip" };

/** Lists a backups BlobStore's zips: only the top level, never the FsStorage sidecars or a zip being written. */
export async function listBackups(store: BlobStore): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  for await (const b of store.list("")) {
    if (b.key.includes("/")) continue;
    out.push({ key: b.key, size: b.size, modified: stamp(b.modified) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Puts a zip under key, refusing a taken one (PB never overwrites a backup). */
export async function writeBackup(store: BlobStore, key: string, body: BlobBody): Promise<void> {
  if (await store.stat(key)) {
    if (body instanceof ReadableStream) await body.cancel();
    throw new Error(`backup ${key} already exists`);
  }
  await store.put(key, body, ZIP);
}

/** PB autobackup pruning: keep the newest `maxKeep` zips with the prefix; returns how many went. */
export async function pruneBackups(store: BlobStore, prefix: string, maxKeep: number): Promise<number> {
  if (maxKeep <= 0) return 0;
  const auto = (await listBackups(store)).filter((b) => b.key.startsWith(prefix));
  auto.sort((a, b) => b.modified.localeCompare(a.modified) || b.key.localeCompare(a.key));
  const old = auto.slice(maxKeep);
  for (const b of old) await store.delete(b.key);
  return old.length;
}

/**
 * PB's backups filesystem: pb_data/backups, or the bucket settings.backups.s3 names. Behind a CurrentStorage so a
 * settings save swaps the backend without rebuilding Backups; a run in flight finishes where it started.
 */
export class BackupStore {
  readonly #current: CurrentStorage;
  #s3: S3Config | null = null;

  constructor(readonly dir: string) {
    this.#current = new CurrentStorage(new FsStorage(dir));
  }

  /** Points at what settings.backups.s3 names. */
  use(cfg: S3Config): void {
    this.#s3 = cfg.enabled ? structuredClone(cfg) : null;
    this.#current.use(cfg);
  }

  /** The config a worker rebuilds the same backend from (null: the local dir). */
  get s3(): S3Config | null {
    return this.#s3;
  }

  get blobs(): BlobStore {
    return this.#current.target;
  }

  list(): Promise<BackupInfo[]> {
    return listBackups(this.blobs);
  }

  async exists(key: string): Promise<boolean> {
    if (!validKey(key)) return false;
    try {
      return (await this.blobs.stat(key)) !== null;
    } catch {
      return false;
    }
  }

  get(key: string): Promise<BlobObject | null> {
    return this.blobs.get(key);
  }

  /** Never overwrites: a taken key fails. */
  write(key: string, body: BlobBody): Promise<void> {
    return writeBackup(this.blobs, key, body);
  }

  delete(key: string): Promise<void> {
    return this.blobs.delete(key);
  }
}
