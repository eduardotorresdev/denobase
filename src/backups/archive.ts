import { SOCKET_PREFIX } from "../services/socket.ts";
import { backup, type DatabaseSync } from "node:sqlite";
import { Inflate, zipSync } from "fflate";
import { crc32 } from "./crc32.ts";

/** The zip a backup is: data.db and auxiliary.db snapshots plus the rest of pb_data, as PB lays it out. */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export const isZip = (b: Uint8Array) => ZIP_MAGIC.every((x, i) => b[i] === x);

/** pb_data entries a backup never carries: its own output, the restore scratch dir and the live db files. */
export function excluded(topLevelName: string): boolean {
  return topLevelName === "backups" || topLevelName === ".pb_temp_to_delete" || topLevelName === ".restoring" ||
    topLevelName === ".restoring.tmp" || topLevelName.startsWith(SOCKET_PREFIX) ||
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

/** Compressed bytes per Inflate push: deflate expands at most ~1032x, so one push yields at most ~8 MiB. */
const PUSH = 8 * 1024;

/**
 * Writes one entry, refusing it as soon as it inflates past its declared size (a zip bomb, or a damaged entry, never
 * fills the disk or the memory); the partial file is removed on any failure.
 */
async function writeEntry(f: Deno.FsFile, e: Entry, start: number, path: string, dictionary?: Uint8Array) {
  const out = await Deno.open(path, { write: true, createNew: true });
  try {
    let written = 0, crc = 0;
    let ready: Uint8Array[] = [];
    const sink = (chunk: Uint8Array) => {
      crc = crc32(crc, chunk);
      written += chunk.byteLength;
      ready.push(chunk);
    };
    const inflate = e.method === 8 ? new Inflate({ dictionary }, (chunk) => sink(chunk)) : null;
    const flush = async () => {
      if (written > e.size) throw new Error(`backup entry is larger than it declares: ${e.name}`);
      const chunks = ready;
      ready = [];
      for (const c of chunks) for (let off = 0; off < c.byteLength;) off += await out.write(c.subarray(off));
    };
    await f.seek(start, Deno.SeekMode.Start);
    const buf = new Uint8Array(1 << 20);
    // At least one pass, so an empty deflated entry still gets its final (empty) block.
    let left = e.compressed;
    do {
      const n = left ? await f.read(buf.subarray(0, Math.min(buf.length, left))) : 0;
      if (n === null) throw new Error(`backup zip is truncated: ${e.name}`);
      left -= n;
      let p = 0;
      do {
        const end = Math.min(n, p + PUSH);
        const chunk = buf.slice(p, end);
        if (inflate) inflate.push(chunk, left === 0 && end === n);
        else sink(chunk);
        await flush();
        p = end;
      } while (p < n);
    } while (left > 0);
    if (written !== e.size || crc !== e.crc) throw new Error(`backup entry is damaged: ${e.name}`);
    out.close();
  } catch (err) {
    out.close();
    await Deno.remove(path).catch(() => {});
    throw err;
  }
}

/** A zip entry name that stays inside the extraction dir. */
function safeEntry(name: string): boolean {
  return !name.startsWith("/") && !name.includes("\\") && !name.split("/").some((p) => p === ".." || p === "");
}

/** A zip entry as its central directory record describes it. */
interface Entry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  /** Offset of its local header. */
  offset: number;
}

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50, SIG_LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;

async function readAt(f: Deno.FsFile, offset: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  await f.seek(offset, Deno.SeekMode.Start);
  for (let got = 0; got < length;) {
    const n = await f.read(buf.subarray(got));
    if (n === null) throw new Error("backup zip is truncated");
    got += n;
  }
  return buf;
}

/**
 * The entries, from the central directory at the end of the file (zip64 too: PB writes it for big backups). The
 * directory is the zip's index: a streaming reader that looks for the next signature inside the data instead finds
 * `PK..` byte runs in the compressed bytes of any large or incompressible entry and cuts it (the restore failing on a
 * valid zip, X1).
 */
async function centralDirectory(f: Deno.FsFile): Promise<Entry[]> {
  const size = (await f.stat()).size;
  // The end record is the last 22 bytes plus a comment of up to 64 KiB.
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(f, size - tailLen, tailLen);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) === tailLen) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== SIG_LOCATOR64) throw new Error("zip64 locator missing");
    const at = Number(tv.getBigUint64(loc + 8, true));
    const z = new DataView((await readAt(f, at, 56)).buffer);
    if (z.getUint32(0, true) !== SIG_EOCD64) throw new Error("zip64 end record missing");
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  const cd = await readAt(f, cdOffset, cdSize);
  const v = new DataView(cd.buffer);
  const names = new TextDecoder();
  const out: Entry[] = [];
  for (let p = 0, k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== SIG_CENTRAL) throw new Error("corrupt central directory");
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const e: Entry = {
      name: names.decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: v.getUint16(p + 10, true),
      crc: v.getUint32(p + 16, true),
      compressed: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
    };
    // Zip64 extra field (0x0001): the 64-bit values of the fields set to 0xffffffff, in this order.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 0x0001) {
        let y = x + 4;
        const next = () => Number((y += 8, v.getBigUint64(y - 8, true)));
        if (e.size === MAX32) e.size = next();
        if (e.compressed === MAX32) e.compressed = next();
        if (e.offset === MAX32) e.offset = next();
      }
      x += 4 + len;
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Unzips the file at zipPath into dir, entry by entry as the central directory places them (offset and size, never a
 * scan for signatures), a MiB at a time so a backup of any size never sits in memory. Each entry's size and CRC are
 * checked; entries that would land outside dir are refused; throws without data.db (not a backup).
 */
export async function extract(zipPath: string, dir: string): Promise<void> {
  const f = await Deno.open(zipPath);
  try {
    const entries = await centralDirectory(f);
    if (!entries.some((e) => e.name === "data.db")) throw new Error("data.db is missing from the backup");
    for (const e of entries) {
      if (e.name.endsWith("/")) continue;
      if (!safeEntry(e.name)) throw new Error(`invalid path in backup: ${e.name}`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`unsupported compression in backup: ${e.name}`);
      const lh = new DataView((await readAt(f, e.offset, 30)).buffer);
      if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error(`corrupt entry in backup: ${e.name}`);
      const start = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const path = `${dir}/${e.name}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      try {
        await writeEntry(f, e, start, path);
      } catch (err) {
        // 0.3.0 wrote some entries whose deflate references bytes before its start, which its encoder's window held
        // as zeros: inflated against a 32 KiB zero dictionary they come back whole, and size and CRC prove it.
        if (e.method !== 8 || !String((err as Error)?.message).includes("invalid distance")) throw err;
        await writeEntry(f, e, start, path, new Uint8Array(32 * 1024));
      }
    }
  } finally {
    f.close();
  }
}
