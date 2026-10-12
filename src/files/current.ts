/**
 * The files storage the app uses right now. PB rebuilds its filesystem from settings.s3 on every use; here the store
 * keeps one BlobStore for its lifetime, so this delegate is what it holds and the backend behind it is swapped when
 * settings.s3 changes. Calls already in flight finish on the backend they started on.
 */
import type { S3Config } from "../settings/model.ts";
import { S3Storage } from "./s3/storage.ts";
import {
  type BlobBody,
  type BlobInfo,
  type BlobMeta,
  type BlobObject,
  type BlobRange,
  type BlobStore,
  FsStorage,
} from "./storage.ts";

/** settings.s3 (or settings.backups.s3) to the BlobStore it names: S3 when enabled, else the local one. */
export function storageFromSettings(cfg: S3Config, local: BlobStore | string): BlobStore {
  if (cfg.enabled) return new S3Storage(cfg);
  return typeof local === "string" ? new FsStorage(local) : local;
}

/** A stable identity for a config, so an unrelated settings save does not rebuild the client. */
function fingerprint(cfg: S3Config): string {
  return cfg.enabled
    ? JSON.stringify([cfg.bucket, cfg.region, cfg.endpoint, cfg.accessKey, cfg.secret, cfg.forcePathStyle])
    : "";
}

export class CurrentStorage implements BlobStore {
  #target: BlobStore;
  #fp = "";

  /** local is where files live while S3 is off (pb_data/storage, or memory). */
  constructor(readonly local: BlobStore) {
    this.#target = local;
  }

  /** The backend calls go to now. */
  get target(): BlobStore {
    return this.#target;
  }

  /** Points at what cfg names; a no-op when the config is the one already in use. */
  use(cfg: S3Config): void {
    const fp = fingerprint(cfg);
    if (fp === this.#fp) return;
    this.#fp = fp;
    this.#target = storageFromSettings(cfg, this.local);
  }

  put(key: string, body: BlobBody, meta: BlobMeta): Promise<void> {
    return this.#target.put(key, body, meta);
  }
  get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null> {
    return this.#target.get(key, opts);
  }
  stat(key: string): Promise<BlobInfo | null> {
    return this.#target.stat(key);
  }
  delete(key: string): Promise<void> {
    return this.#target.delete(key);
  }
  deletePrefix(prefix: string): Promise<void> {
    return this.#target.deletePrefix(prefix);
  }
  list(prefix: string): AsyncIterable<BlobInfo> {
    return this.#target.list(prefix);
  }
}
