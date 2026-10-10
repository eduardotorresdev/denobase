import { tuneConnection } from "../../core/db.ts";
import { backup, DatabaseSync } from "node:sqlite";
import { Zip, ZipDeflate } from "fflate";
import { excluded } from "../archive.ts";
import type { JobContext } from "../../jobs/context.ts";
import type { Attrs, Span } from "../../telemetry/span.ts";

export interface ArchiveInput {
  dataDir: string;
  /** Zip entry name -> db file, each opened here on its own read-only connection. */
  dbPaths: Record<string, string>;
  /** Where the zip goes; never overwritten. */
  out: string;
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
 * - The zip is streamed a MiB at a time from disk to disk: the dbs never sit whole in memory.
 */
export default async function archiveTask(input: ArchiveInput, ctx?: JobContext): Promise<void> {
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
      const files = [...copies, ...await listFiles(input.dataDir)];
      const bytes = await zipTo(input.out, files);
      s?.setAttributes({ "backup.files": files.length, "backup.bytes": bytes });
      totals["backup.zip_bytes"] = bytes;
    });
    if (input.prune) {
      const { prefix, maxKeep } = input.prune;
      await phase(ctx, "retencao", async (s) => {
        const removed = await prune(input.out.slice(0, input.out.lastIndexOf("/")), prefix, maxKeep);
        s?.setAttribute("backup.removed", removed);
      });
    }
    ctx?.record(totals);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Every file under dataDir as [zip entry, path], skipping what a backup never carries. */
async function listFiles(dir: string, prefix = "", out: [string, string][] = []): Promise<[string, string][]> {
  for await (const e of Deno.readDir(dir)) {
    if (!prefix && excluded(e.name)) continue;
    const rel = prefix + e.name;
    if (e.isDirectory) await listFiles(`${dir}/${e.name}`, `${rel}/`, out);
    else if (e.isFile) out.push([rel, `${dir}/${e.name}`]);
  }
  return out;
}

/** Streams the files into a new zip at out (never overwritten); returns its size. */
async function zipTo(out: string, files: [string, string][]): Promise<number> {
  const file = await Deno.open(out, { createNew: true, write: true });
  let size = 0;
  let writing = Promise.resolve();
  let failed: unknown;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else {
      size += chunk.byteLength;
      writing = writing.then(() => writeAll(file, chunk));
    }
  });
  try {
    for (const [name, path] of files) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      const src = await Deno.open(path);
      try {
        const buf = new Uint8Array(CHUNK);
        for (;;) {
          const n = await src.read(buf);
          if (n === null) break;
          entry.push(buf.slice(0, n));
          // Lets the output drain before the next MiB, so memory stays a few chunks.
          await writing;
        }
        entry.push(new Uint8Array(0), true);
      } finally {
        src.close();
      }
    }
    zip.end();
    await writing;
    if (failed) throw failed;
  } finally {
    file.close();
  }
  return size;
}

/** FsFile.write may take fewer bytes than given. */
async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  for (let off = 0; off < chunk.byteLength;) off += await file.write(chunk.subarray(off));
}

/** PB autobackup pruning: keep the newest `maxKeep` files with the prefix; returns how many went. */
async function prune(dir: string, prefix: string, maxKeep: number): Promise<number> {
  if (maxKeep <= 0) return 0;
  const auto: { name: string; mtime: number }[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.startsWith(prefix)) continue;
    auto.push({ name: e.name, mtime: (await Deno.stat(`${dir}/${e.name}`)).mtime?.getTime() ?? 0 });
  }
  auto.sort((a, b) => b.mtime - a.mtime);
  const old = auto.slice(maxKeep);
  for (const f of old) await Deno.remove(`${dir}/${f.name}`);
  return old.length;
}
