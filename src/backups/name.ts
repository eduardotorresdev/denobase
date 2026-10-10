import { snakecase } from "../core/text.ts";

/** Keys are plain file names: nothing that could walk out of the backups dir. */
export function validKey(key: string): boolean {
  return !!key && !key.includes("/") && !key.includes("\\") && key !== "." && key !== "..";
}

/** PB generateBackupName: "<prefix><snake app name>_<UTC yyyymmddhhmmss>.zip". */
export function backupName(appName: string, prefix: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${prefix}${snakecase(appName).slice(0, 50)}_${ts}.zip`;
}
