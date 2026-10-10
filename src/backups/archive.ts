import { backup, type DatabaseSync } from "node:sqlite";
import { unzipSync, zipSync } from "fflate";

/** The zip a backup is: data.db and auxiliary.db snapshots plus the rest of pb_data, as PB lays it out. */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export const isZip = (b: Uint8Array) => ZIP_MAGIC.every((x, i) => b[i] === x);

/** pb_data entries a backup never carries: its own output, the restore scratch dir and the live db files. */
export function excluded(topLevelName: string): boolean {
  return topLevelName === "backups" || topLevelName === ".pb_temp_to_delete" ||
    /^(data|auxiliary)\.db(-wal|-shm|-journal)?$/.test(topLevelName);
}

/** Every file under dir as "rel/path" -> bytes, skipping the excluded top-level entries. */
export async function collect(dir: string, prefix: string, files: Record<string, Uint8Array>): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    if (!prefix && excluded(e.name)) continue;
    const rel = prefix + e.name;
    if (e.isDirectory) await collect(`${dir}/${e.name}`, `${rel}/`, files);
    else if (e.isFile) files[rel] = await Deno.readFile(`${dir}/${e.name}`);
  }
}

/**
 * Zips a consistent copy of pb_data: each db through SQLite's online backup API (Deno's sqlite refuses VACUUM INTO
 * and ATTACH on other files), then the other files as they are on disk.
 */
export async function archive(dataDir: string, dbs: Record<string, DatabaseSync>): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir();
  try {
    const files: Record<string, Uint8Array> = {};
    for (const [name, db] of Object.entries(dbs)) {
      const path = `${tmp}/${name}`;
      await backup(db, path);
      files[name] = await Deno.readFile(path);
    }
    await collect(dataDir, "", files);
    return zipSync(files);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Unzips into dir, refusing entries that would land outside it; throws without data.db (not a backup). */
export async function extract(zip: Uint8Array, dir: string): Promise<void> {
  const entries = unzipSync(zip);
  if (!entries["data.db"]) throw new Error("data.db is missing from the backup");
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || name.split("/").some((p) => p === ".." || p === "")) {
      throw new Error(`invalid path in backup: ${name}`);
    }
    const path = `${dir}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, data);
  }
}
