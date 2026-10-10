import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../core/db.ts";

/** PB's pb_data: where the db lives by default (env DB_PATH overrides). */
export const DEFAULT_DB = "pb_data/data.db";

/** The dir holding the db file, or null for a bare file name (then there is no pb_data dir to own). */
export function dataDirOf(path: string): string | null {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
}

export function openFileDb(path = Deno.env.get("DB_PATH") ?? DEFAULT_DB): DatabaseSync {
  const dir = dataDirOf(path);
  if (dir) Deno.mkdirSync(dir, { recursive: true });
  return openDb(path);
}
