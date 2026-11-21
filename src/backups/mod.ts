import type { DatabaseSync } from "node:sqlite";
import { archive } from "./archive.ts";
import { dbPath, runTask } from "../workers/mod.ts";
import archiveTask, { type ArchiveInput } from "./tasks/archive.ts";
import type { ExtractInput } from "./tasks/extract.ts";
import { type BackupInfo, BackupStore, pruneBackups } from "./store.ts";
import type { BlobInfo, BlobObject, BlobRange } from "../files/storage.ts";
import type { S3Config } from "../settings/model.ts";
import { swapDataDir, TRASH_DIR } from "./restore.ts";
import { openDb } from "../core/db.ts";
import { sweepRestored } from "../queue/table.ts";
import { withMarker } from "../queue/restore_marker.ts";
import type { JobCtx } from "../queue/types.ts";

export { isZip } from "./archive.ts";
export { backupName, validKey } from "./name.ts";
export type { BackupInfo } from "./store.ts";
export { autoBackups, BACKUP_JOB, backupJobs, BACKUPS_KEY, RESTORE_JOB } from "./auto.ts";

/**
 * PB-style backups over pb_data, zips kept in pb_data/backups or in the bucket settings.backups.s3 names (`use`, run
 * on every settings change). One backup or restore at a time across every process: both are jobs of the queue under
 * the dedupe key `backups` (§8); this class does the work where the job runs.
 */
export class Backups {
  readonly #store: BackupStore;
  /** PB carries pb_data/storage only while files are local; with settings.s3 on it is not the files. */
  #filesLocal = true;

  constructor(
    readonly dataDir: string,
    readonly db: DatabaseSync,
    readonly auxDb: DatabaseSync,
    /** Runs after a restore swapped pb_data; PB restarts the process (see serve). */
    readonly onRestored: () => void,
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
  get(key: string, opts?: { range?: BlobRange }): Promise<BlobObject | null> {
    return this.#store.get(key, opts);
  }
  /** Size and mod time, for Range and conditional downloads; null when absent. */
  stat(key: string): Promise<BlobInfo | null> {
    return this.#store.stat(key);
  }
  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }
  upload(key: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    return this.#store.write(key, data);
  }

  /**
   * Zips pb_data into `key` here (the heavy executor running the backup job); `prune` then keeps the newest maxKeep
   * zips with that prefix. Callers go through the queue (BACKUP_JOB), which keeps it to one at a time.
   */
  async create(
    key: string,
    prune?: { prefix: string; maxKeep: number },
    ctx?: Pick<JobCtx, "span" | "record">,
  ): Promise<void> {
    const dbs = { "data.db": this.db, "auxiliary.db": this.auxDb };
    const paths = Object.entries(dbs).map(([name, db]) => [name, dbPath(db)] as const);
    if (paths.some(([, p]) => !p)) {
      // An in-memory db only exists on this connection, so it is snapshotted here.
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
    await archiveTask(input, ctx);
  }

  /**
   * PB RestoreBackup: download the zip into pb_data's trash dir (streamed, so S3 works the same as local), extract it
   * next to pb_data, sweep its _jobs, swap it in, then restart: the open db handles still point at the old files.
   * While it runs the `.restoring` marker tells every other node to stop and go (§16 N6); it is removed before the
   * restart, which the other nodes also see through data.db's inode.
   */
  async restore(key: string, owner = `restore:${Deno.pid}`): Promise<void> {
    const marker = { owner, pid: Deno.pid, host: Deno.hostname(), started: Date.now(), key };
    await withMarker(this.dataDir, marker, async () => {
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
        // Inflating is CPU-heavy and runs on the serve: a thread of its own, which holds no db connection.
        await runTask(new URL("./tasks/extract.ts", import.meta.url), input);
        // Nothing pending or running when the zip was taken runs again (the backup itself, old sends).
        if (await Deno.stat(`${extracted}/data.db`).then(() => true, () => false)) {
          const restored = openDb(`${extracted}/data.db`);
          try {
            sweepRestored(restored, Date.now());
          } finally {
            restored.close();
          }
        }
      } catch (e) {
        await Deno.remove(extracted, { recursive: true }).catch(() => {});
        throw e;
      } finally {
        await Deno.remove(zip).catch(() => {});
      }
      await swapDataDir(this.dataDir, extracted, id);
    });
    this.onRestored();
  }

  /** PB autobackup pruning: keep the newest `maxKeep` keys with the given prefix. */
  async prune(prefix: string, maxKeep: number): Promise<void> {
    await pruneBackups(this.#store.blobs, prefix, maxKeep);
  }
}
