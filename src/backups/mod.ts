import type { DatabaseSync } from "node:sqlite";
import { archive } from "./archive.ts";
import { dbPath, runTask } from "../workers/mod.ts";
import type { ArchiveInput } from "./tasks/archive.ts";
import type { ExtractInput } from "./tasks/extract.ts";
import { type BackupInfo, BackupStore } from "./store.ts";
import { swapDataDir, TRASH_DIR } from "./restore.ts";

export { isZip } from "./archive.ts";
export { backupName, validKey } from "./name.ts";
export type { BackupInfo } from "./store.ts";
export { autoBackups } from "./auto.ts";

/**
 * PB-style backups over pb_data on disk: one backup or restore at a time, zips kept
 * in pb_data/backups.
 */
export class Backups {
  /** The key being created or restored; blocks a second run and its deletion. */
  active: string | null = null;
  readonly #store: BackupStore;

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

  list(): Promise<BackupInfo[]> {
    return this.#store.list();
  }
  exists(key: string): Promise<boolean> {
    return this.#store.exists(key);
  }
  read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.#store.read(key);
  }
  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }
  upload(key: string, data: Uint8Array): Promise<void> {
    return this.#store.write(key, data);
  }

  /** Zips pb_data into `key`, in the worker; `prune` then keeps the newest maxKeep zips with that prefix. */
  async create(key: string, prune?: { prefix: string; maxKeep: number }): Promise<void> {
    await this.#exclusive(key, async () => {
      const dbs = { "data.db": this.db, "auxiliary.db": this.auxDb };
      const paths = Object.entries(dbs).map(([name, db]) => [name, dbPath(db)] as const);
      if (paths.some(([, p]) => !p)) {
        // An in-memory db only exists on this thread's connection, so it is snapshotted here.
        await this.#store.write(key, await archive(this.dataDir, dbs));
        if (prune) await this.prune(prune.prefix, prune.maxKeep);
        return;
      }
      await Deno.mkdir(this.#store.dir, { recursive: true });
      const input: ArchiveInput = {
        dataDir: this.dataDir,
        dbPaths: Object.fromEntries(paths) as Record<string, string>,
        out: `${this.#store.dir}/${key}`,
        prune,
      };
      await this.runInWorker(new URL("./tasks/archive.ts", import.meta.url), input);
    });
  }

  /** Extract next to pb_data, swap it in, then restart: the open db handles still point at the old files. */
  async restore(key: string): Promise<void> {
    await this.#exclusive(key, async () => {
      const id = Date.now();
      const extracted = `${this.dataDir}/${TRASH_DIR}/pb_restore_${id}`;
      const input: ExtractInput = { zip: `${this.#store.dir}/${key}`, dir: extracted };
      await runTask(new URL("./tasks/extract.ts", import.meta.url), input);
      await swapDataDir(this.dataDir, extracted, id);
      this.onRestored();
    });
  }

  /** PB autobackup pruning: keep the newest `maxKeep` keys with the given prefix. */
  async prune(prefix: string, maxKeep: number): Promise<void> {
    if (maxKeep <= 0) return;
    const auto = (await this.list()).filter((b) => b.key.startsWith(prefix));
    auto.sort((a, b) => b.modified.localeCompare(a.modified));
    for (const b of auto.slice(maxKeep)) await this.delete(b.key);
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
