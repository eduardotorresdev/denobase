import { backup, type DatabaseSync } from "node:sqlite";
import { Unzip, UnzipInflate, zipSync } from "fflate";

/** The zip a backup is: data.db and auxiliary.db snapshots plus the rest of pb_data, as PB lays it out. */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export const isZip = (b: Uint8Array) => ZIP_MAGIC.every((x, i) => b[i] === x);

/** pb_data entries a backup never carries: its own output, the restore scratch dir and the live db files. */
export function excluded(topLevelName: string): boolean {
  return topLevelName === "backups" || topLevelName === ".pb_temp_to_delete" ||
    /^(data|auxiliary)\.db(-wal|-shm|-journal)?$/.test(topLevelName);
}

/** Every file under dir as "rel/path" -> bytes, skipping the excluded top-level entries. */
export async function collect(
  dir: string,
  prefix: string,
  files: Record<string, Uint8Array>,
  includeStorage = true,
): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    if (!prefix && (excluded(e.name) || (!includeStorage && e.name === "storage"))) continue;
    const rel = prefix + e.name;
    if (e.isDirectory) await collect(`${dir}/${e.name}`, `${rel}/`, files, includeStorage);
    else if (e.isFile) files[rel] = await Deno.readFile(`${dir}/${e.name}`);
  }
}

/**
 * Zips a consistent copy of pb_data: each db through SQLite's online backup API (Deno's sqlite refuses VACUUM INTO
 * and ATTACH on other files), then the other files as they are on disk.
 */
export async function archive(
  dataDir: string,
  dbs: Record<string, DatabaseSync>,
  includeStorage = true,
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir();
  try {
    const files: Record<string, Uint8Array> = {};
    for (const [name, db] of Object.entries(dbs)) {
      const path = `${tmp}/${name}`;
      await backup(db, path);
      files[name] = await Deno.readFile(path);
    }
    await collect(dataDir, "", files, includeStorage);
    return zipSync(files);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** A zip entry name that stays inside the extraction dir. */
function safeEntry(name: string): boolean {
  return !name.startsWith("/") && !name.includes("\\") && !name.split("/").some((p) => p === ".." || p === "");
}

/**
 * Unzips the file at zipPath into dir a MiB at a time (inflate and writes paced by the reads, so a backup of any
 * size never sits in memory), refusing entries that would land outside dir; throws without data.db (not a backup).
 */
export async function extract(zipPath: string, dir: string): Promise<void> {
  let failed: unknown;
  let pending = Promise.resolve();
  let hasDb = false;
  const queue = (fn: () => Promise<void>) => {
    pending = pending.then(fn).catch((e) => {
      failed ??= e;
    });
  };
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    if (!safeEntry(file.name)) {
      failed ??= new Error(`invalid path in backup: ${file.name}`);
      return;
    }
    if (file.name === "data.db") hasDb = true;
    const path = `${dir}/${file.name}`;
    let out: Deno.FsFile | null = null;
    queue(async () => {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      out = await Deno.open(path, { write: true, createNew: true });
    });
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed ??= err;
        return;
      }
      queue(async () => {
        if (!out) return;
        for (let off = 0; off < chunk.byteLength;) off += await out.write(chunk.subarray(off));
        if (final) {
          out.close();
          out = null;
        }
      });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const src = await Deno.open(zipPath);
  try {
    const buf = new Uint8Array(1 << 20);
    for (;;) {
      const n = await src.read(buf);
      if (n === null) break;
      unzip.push(buf.slice(0, n));
      await pending;
      if (failed) throw failed;
    }
    unzip.push(new Uint8Array(0), true);
    await pending;
    if (failed) throw failed;
  } finally {
    src.close();
  }
  if (!hasDb) throw new Error("data.db is missing from the backup");
}
