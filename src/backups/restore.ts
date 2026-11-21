import { MARKER } from "../queue/restore_marker.ts";
import { SOCKET_PREFIX } from "../services/socket.ts";

/** Where restore stages and parks files; PB's LocalTempDirName. */
export const TRASH_DIR = ".pb_temp_to_delete";

/**
 * PB RestoreBackup's swap: the current pb_data content (but backups/ and the trash itself) moves to
 * <trash>/pb_old_<id>, then every extracted entry moves in. Renames only, so it is quick and on one filesystem.
 */
export async function swapDataDir(dataDir: string, extractedDir: string, id: number): Promise<void> {
  const old = `${dataDir}/${TRASH_DIR}/pb_old_${id}`;
  await Deno.mkdir(old, { recursive: true });
  for await (const e of Deno.readDir(dataDir)) {
    // The restore marker stays: a node starting mid-swap must still see it (§16 N6).
    if (e.name === "backups" || e.name === TRASH_DIR || e.name === MARKER || e.name.startsWith(SOCKET_PREFIX)) continue;
    await Deno.rename(`${dataDir}/${e.name}`, `${old}/${e.name}`);
  }
  for await (const e of Deno.readDir(extractedDir)) {
    await Deno.rename(`${extractedDir}/${e.name}`, `${dataDir}/${e.name}`);
  }
}
