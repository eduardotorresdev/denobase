/**
 * The restore's signal to every node (§8, §16 N6, §17): `pb_data/.restoring`, outside both dbs (both are swapped),
 * kept by swapDataDir and never zipped. Its owner beats it every BEAT_MS; one silent for ORPHAN_MS is an orphan.
 * Independently of time, every node compares the (dev, ino) of data.db it opened with the file at the path: a
 * mismatch, or no file at all, means the data dir was swapped under it.
 */
export const MARKER = ".restoring";
export const MARKER_BEAT_MS = 2_000;
export const ORPHAN_MS = 20_000;

export interface Marker {
  owner: string;
  pid: number;
  host: string;
  started: number;
  beat: number;
  key: string;
}

export const markerPath = (dataDir: string) => `${dataDir}/${MARKER}`;

export function readMarker(dataDir: string | undefined): Marker | null {
  if (!dataDir) return null;
  try {
    return JSON.parse(Deno.readTextFileSync(markerPath(dataDir))) as Marker;
  } catch {
    return null;
  }
}

export function writeMarker(dataDir: string, m: Marker): void {
  const tmp = `${markerPath(dataDir)}.tmp`;
  Deno.writeTextFileSync(tmp, JSON.stringify(m));
  Deno.renameSync(tmp, markerPath(dataDir));
}

export function removeMarker(dataDir: string): void {
  try {
    Deno.removeSync(markerPath(dataDir));
  } catch { /* already gone */ }
}

export function isOrphan(m: Marker, now = Date.now()): boolean {
  return now - m.beat > ORPHAN_MS;
}

/** `dev:ino` of the file at path; null when there is none (in memory, or mid-swap). */
export function fileId(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    const s = Deno.statSync(path);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/** Whether path is still the file opened as `opened`; NotFound counts as changed (§17), never as an error. */
export function sameFileId(path: string | null | undefined, opened: string | null): boolean {
  if (!path || !opened) return true;
  return fileId(path) === opened;
}

/** Beats the marker while fn runs; removes it at the end, success or failure. */
export async function withMarker<T>(dataDir: string, m: Omit<Marker, "beat">, fn: () => Promise<T>): Promise<T> {
  const write = () => writeMarker(dataDir, { ...m, beat: Date.now() });
  write();
  const timer = setInterval(() => {
    try {
      write();
    } catch (e) {
      console.error("restore marker:", (e as Error).message);
    }
  }, MARKER_BEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    removeMarker(dataDir);
  }
}
