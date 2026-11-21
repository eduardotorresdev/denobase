import { TRASH_DIR } from "../restore.ts";
import { tuneConnection } from "../../core/db.ts";
import { backup, DatabaseSync } from "node:sqlite";
import { type AsyncFlateStreamHandler, Zip, type ZipInputFile } from "fflate";
import { crc32 } from "../crc32.ts";
import { excluded } from "../archive.ts";
import { pruneBackups, writeBackup } from "../store.ts";
import { storageFromSettings } from "../../files/current.ts";
import type { S3Config } from "../../settings/model.ts";
import type { JobCtx } from "../../queue/types.ts";

type JobContext = Pick<JobCtx, "span"> & Partial<Pick<JobCtx, "record">>;
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

/** Each phase is a span when the job runs traced; without a context the phases just run. */
function phase<T>(ctx: JobContext | undefined, name: string, fn: (s?: Span) => T | Promise<T>): Promise<T> {
  return ctx ? ctx.span(`backup.${name}`, undefined, fn) : Promise.resolve().then(() => fn());
}

const CHUNK = 1 << 20;
const STAGE_PREFIX = "pb_backup_stage_";

/**
 * The whole backup, in the heavy executor that runs the backup job, out of the serve's way.
 * - No checkpoint: it would write the WAL back into the db file, competing for the disk with every commit.
 * - The online backup copies each db in ONE step (rate -1), under one read snapshot: in WAL a reader blocks no one,
 *   while a stepped backup restarts from page one whenever another connection commits (the main thread writes the
 *   auxiliary db on every request), re-reading the file over and over.
 * - The zip is streamed a MiB at a time to the backups store (a local file, or an S3 multipart upload): the dbs
 *   never sit whole in memory.
 */
export default async function archiveTask(input: ArchiveInput, ctx?: JobContext): Promise<void> {
  const store = storageFromSettings(input.store.s3 ?? { enabled: false } as S3Config, input.store.dir);
  // The db copies stage under pb_data's own trash dir (never zipped, never swapped), named so the next backup clears
  // what a killed one left: one backup runs at a time (the `backups` key), so any leftover is dead (R4).
  const trash = `${input.dataDir}/${TRASH_DIR}`;
  await Deno.mkdir(trash, { recursive: true });
  for await (const e of Deno.readDir(trash)) {
    if (e.name.startsWith(STAGE_PREFIX)) await Deno.remove(`${trash}/${e.name}`, { recursive: true }).catch(() => {});
  }
  const tmp = await Deno.makeTempDir({ dir: trash, prefix: STAGE_PREFIX });
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
    ctx?.record?.(totals);
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
 * One entry compressed by the runtime's own zlib (CompressionStream "deflate-raw"), with its CRC and size counted
 * here: fflate keeps the zip container only. fflate's streaming Deflate writes invalid streams for some inputs
 * (back references past the start, "invalid distance too far back": a third of the inputs of one periodic pattern in a
 * fuzz), and a backup with such an entry never restores.
 */
class NativeDeflate implements ZipInputFile {
  size = 0;
  crc = 0;
  readonly compression = 8;
  ondata?: AsyncFlateStreamHandler;
  constructor(readonly filename: string) {}
}

/**
 * The files as one zip stream, pulled: each pull compresses the next MiB, so the output's backpressure (a disk, or an
 * S3 multipart part being sent) paces the reads and memory stays a few chunks whatever the backup's size.
 */
export function zipStream(files: [string, string][], counter: { bytes: number }): ReadableStream<Uint8Array> {
  let out: Uint8Array[] = [];
  let failed: unknown;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else if (chunk.byteLength) out.push(chunk);
  });
  const drain = () => {
    if (failed) throw failed;
    const ready = out;
    out = [];
    for (const c of ready) counter.bytes += c.byteLength;
    return ready;
  };
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const buf = new Uint8Array(CHUNK);
    for (const [name, path] of files) {
      const entry = new NativeDeflate(name);
      zip.add(entry);
      const deflate = new CompressionStream("deflate-raw");
      const writer = deflate.writable.getWriter();
      // The compressed output goes to the zip as it comes; the writes below wait on it (the stream's backpressure).
      const pump = (async () => {
        for await (const c of deflate.readable) entry.ondata!(null, c, false);
      })();
      const src = await Deno.open(path);
      try {
        for (;;) {
          const n = await src.read(buf);
          if (n === null) break;
          const chunk = buf.slice(0, n);
          entry.crc = crc32(entry.crc, chunk);
          entry.size += n;
          await writer.write(chunk);
          yield* drain();
        }
      } finally {
        src.close();
      }
      await writer.close();
      await pump;
      entry.ondata!(null, new Uint8Array(0), true);
      yield* drain();
    }
    zip.end();
    yield* drain();
  }
  const it = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const r = await it.next();
        if (r.done) ctl.close();
        else ctl.enqueue(r.value);
      } catch (e) {
        ctl.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
      zip.terminate();
    },
  });
}
