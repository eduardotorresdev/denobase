import { tuneConnection } from "../../core/db.ts";
import { backup, DatabaseSync } from "node:sqlite";
import { Zip, ZipDeflate } from "fflate";
import { excluded } from "../archive.ts";
import { pruneBackups, writeBackup } from "../store.ts";
import { storageFromSettings } from "../../files/current.ts";
import type { S3Config } from "../../settings/model.ts";
import type { JobContext } from "../../jobs/context.ts";
import type { Attrs, Span } from "../../telemetry/span.ts";

export interface ArchiveInput {
  dataDir: string;
  /** Zip entry name -> db file, each opened here on its own read-only connection. */
  dbPaths: Record<string, string>;
  /** The backups store the zip goes to, rebuilt here: settings.backups.s3 when enabled, else the local dir. */
  store: { dir: string; s3: S3Config | null };
  /** The zip's key in it; never overwritten. */
  key: string;
  /** pb_data/storage is carried only while it holds the files (PB): with files on S3 it is a leftover. */
  includeStorage: boolean;
  /** Retention after the zip is written: keep the newest `maxKeep` zips whose name starts with `prefix`. */
  prune?: { prefix: string; maxKeep: number };
}

/** Each phase is a span when the job runs traced; without a context (runTask) the phases just run. */
function phase<T>(ctx: JobContext | undefined, name: string, fn: (s?: Span) => T | Promise<T>): Promise<T> {
  return ctx ? ctx.span(`backup.${name}`, undefined, fn) : Promise.resolve().then(() => fn());
}

const CHUNK = 1 << 20;

/**
 * Worker task: the whole backup off the main thread, and out of its way.
 * - No checkpoint: it would write the WAL back into the db file, competing for the disk with every commit.
 * - The online backup copies each db in ONE step (rate -1), under one read snapshot: in WAL a reader blocks no one,
 *   while a stepped backup restarts from page one whenever another connection commits (the main thread writes the
 *   auxiliary db on every request), re-reading the file over and over.
 * - The zip is streamed a MiB at a time to the backups store (a local file, or an S3 multipart upload): the dbs
 *   never sit whole in memory.
 */
export default async function archiveTask(input: ArchiveInput, ctx?: JobContext): Promise<void> {
  const store = storageFromSettings(input.store.s3 ?? { enabled: false } as S3Config, input.store.dir);
  const tmp = await Deno.makeTempDir();
  const totals: Attrs = {};
  try {
    const copies: [string, string][] = [];
    await phase(ctx, "copia_online", async (s) => {
      let bytes = 0;
      for (const [name, path] of Object.entries(input.dbPaths)) {
        const db = new DatabaseSync(path, { readOnly: true });
        tuneConnection(db, { file: true, readOnly: true });
        try {
          await backup(db, `${tmp}/${name}`, { rate: -1 });
        } finally {
          db.close();
        }
        copies.push([name, `${tmp}/${name}`]);
        bytes += (await Deno.stat(`${tmp}/${name}`)).size;
      }
      s?.setAttribute("backup.bytes", bytes);
      totals["backup.db_bytes"] = bytes;
    });
    await phase(ctx, "zip", async (s) => {
      const skip = (top: string) => !input.includeStorage && top === "storage";
      const files = [...copies, ...await listFiles(input.dataDir, skip)];
      const counter = { bytes: 0 };
      await writeBackup(store, input.key, zipStream(files, counter));
      s?.setAttributes({ "backup.files": files.length, "backup.bytes": counter.bytes });
      totals["backup.zip_bytes"] = counter.bytes;
    });
    if (input.prune) {
      const { prefix, maxKeep } = input.prune;
      await phase(ctx, "retencao", async (s) => {
        const removed = await pruneBackups(store, prefix, maxKeep);
        s?.setAttribute("backup.removed", removed);
      });
    }
    ctx?.record(totals);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Every file under dataDir as [zip entry, path], skipping what a backup never carries. */
async function listFiles(
  dir: string,
  skip: (top: string) => boolean,
  prefix = "",
  out: [string, string][] = [],
): Promise<[string, string][]> {
  for await (const e of Deno.readDir(dir)) {
    if (!prefix && (excluded(e.name) || skip(e.name))) continue;
    const rel = prefix + e.name;
    if (e.isDirectory) await listFiles(`${dir}/${e.name}`, skip, `${rel}/`, out);
    else if (e.isFile) out.push([rel, `${dir}/${e.name}`]);
  }
  return out;
}

/**
 * The files as one zip stream, pulled: each pull deflates the next MiB, so the output's backpressure (a disk, or an
 * S3 multipart part being sent) paces the reads and memory stays a few chunks whatever the backup's size.
 */
export function zipStream(files: [string, string][], counter: { bytes: number }): ReadableStream<Uint8Array> {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let failed: unknown;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else if (chunk.byteLength) {
      counter.bytes += chunk.byteLength;
      ctl.enqueue(chunk);
    }
  });
  let i = 0;
  let src: Deno.FsFile | null = null;
  let entry: ZipDeflate | null = null;
  const buf = new Uint8Array(CHUNK);
  const closeSrc = () => {
    try {
      src?.close();
    } catch { /* already closed */ }
    src = null;
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    // A pull that enqueues nothing is not repeated by the stream, so it reads on until deflate emits or the zip ends.
    async pull() {
      try {
        const before = counter.bytes;
        while (counter.bytes === before) {
          if (!src) {
            if (i >= files.length) {
              zip.end();
              if (failed) throw failed;
              ctl.close();
              return;
            }
            const [name, path] = files[i++];
            entry = new ZipDeflate(name, { level: 6 });
            zip.add(entry);
            src = await Deno.open(path);
          }
          const n = await src.read(buf);
          if (n === null) {
            closeSrc();
            entry!.push(new Uint8Array(0), true);
          } else entry!.push(buf.slice(0, n));
          if (failed) throw failed;
        }
      } catch (e) {
        closeSrc();
        ctl.error(e);
      }
    },
    cancel() {
      closeSrc();
      zip.terminate();
    },
  });
}
