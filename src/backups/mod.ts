import type { DatabaseSync } from "node:sqlite";
import { archive } from "./archive.ts";
import { dbPath, runTask } from "../workers/mod.ts";
import type { ArchiveInput } from "./tasks/archive.ts";
import type { ExtractInput } from "./tasks/extract.ts";
import { type BackupInfo, BackupStore, pruneBackups } from "./store.ts";
import type { BlobObject } from "../files/storage.ts";
import type { S3Config } from "../settings/model.ts";
import { swapDataDir, TRASH_DIR } from "./restore.ts";

export { isZip } from "./archive.ts";
export { backupName, validKey } from "./name.ts";
export type { BackupInfo } from "./store.ts";
export { autoBackups } from "./auto.ts";

/**
 * PB-style backups over pb_data: one backup or restore at a time, zips kept in pb_data/backups or in the bucket
 * settings.backups.s3 names (`use`, run on every settings change).
 */
export class Backups {
  /** The key being created or restored; blocks a second run and its deletion. */
  active: string | null = null;
  readonly #store: BackupStore;
  /** PB carries pb_data/storage only while files are local; with settings.s3 on it is not the files. */
  #filesLocal = true;

  constructor(
    readonly dataDir: string,
    readonly db: DatabaseSync,
    readonly auxDb: DatabaseSync,
    /** Runs after a restore swapped pb_data; PB restarts the process (see serve). */
    readonly onRestored: () => void,
    /** Where a backup runs: the app's job worker (app.jobs); a fresh worker per run by default. */
    readonly runInWorker: (module: URL, input: unknown) => Promise<unknown> = runTask,
  ) {
    this.#store = new BackupStore(`${dataDir}/backups`);
  }

  get dir(): string {
    return this.#store.dir;
  }

  /** Applies settings: settings.backups.s3 picks the store, settings.s3 whether storage/ goes in the zip. */
  use(backupsS3: S3Config, filesS3: S3Config): void {
    this.#store.use(backupsS3);
    this.#filesLocal = !filesS3.enabled;
  }

  list(): Promise<BackupInfo[]> {
    return this.#store.list();
  }
  exists(key: string): Promise<boolean> {
    return this.#store.exists(key);
  }
  /** The zip as a stream; null when absent. */
  get(key: string): Promise<BlobObject | null> {
    return this.#store.get(key);
  }
  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }
  upload(key: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    return this.#store.write(key, data);
  }

  /** Zips pb_data into `key`, in the worker; `prune` then keeps the newest maxKeep zips with that prefix. */
  async create(key: string, prune?: { prefix: string; maxKeep: number }): Promise<void> {
    await this.#exclusive(key, async () => {
      const dbs = { "data.db": this.db, "auxiliary.db": this.auxDb };
      const paths = Object.entries(dbs).map(([name, db]) => [name, dbPath(db)] as const);
      if (paths.some(([, p]) => !p)) {
        // An in-memory db only exists on this thread's connection, so it is snapshotted here.
        await this.#store.write(key, await archive(this.dataDir, dbs, this.#filesLocal));
        if (prune) await this.prune(prune.prefix, prune.maxKeep);
        return;
      }
      const input: ArchiveInput = {
        dataDir: this.dataDir,
        dbPaths: Object.fromEntries(paths) as Record<string, string>,
        store: { dir: this.#store.dir, s3: this.#store.s3 },
        key,
        includeStorage: this.#filesLocal,
        prune,
      };
      await this.runInWorker(new URL("./tasks/archive.ts", import.meta.url), input);
    });
  }

  /**
   * PB RestoreBackup: download the zip into pb_data's trash dir (streamed, so S3 works the same as local), extract it
   * next to pb_data, swap it in, then restart: the open db handles still point at the old files.
   */
  async restore(key: string): Promise<void> {
    await this.#exclusive(key, async () => {
      const id = Date.now();
      const trash = `${this.dataDir}/${TRASH_DIR}`;
      const zip = `${trash}/pb_restore_${id}.zip`;
      const extracted = `${trash}/pb_restore_${id}`;
      await Deno.mkdir(trash, { recursive: true });
      try {
        const obj = await this.#store.get(key);
        if (!obj) throw new Error(`backup ${key} not found`);
        await Deno.writeFile(zip, obj.body, { createNew: true });
        const input: ExtractInput = { zip, dir: extracted };
        await runTask(new URL("./tasks/extract.ts", import.meta.url), input);
      } catch (e) {
        await Deno.remove(extracted, { recursive: true }).catch(() => {});
        throw e;
      } finally {
        await Deno.remove(zip).catch(() => {});
      }
      await swapDataDir(this.dataDir, extracted, id);
      this.onRestored();
    });
  }

  /** PB autobackup pruning: keep the newest `maxKeep` keys with the given prefix. */
  async prune(prefix: string, maxKeep: number): Promise<void> {
    await pruneBackups(this.#store.blobs, prefix, maxKeep);
  }

  async #exclusive(key: string, fn: () => Promise<void>): Promise<void> {
    if (this.active) throw new Error("another backup/restore process has already been started");
    this.active = key;
    try {
      await fn();
    } finally {
      this.active = null;
    }
  }
}
