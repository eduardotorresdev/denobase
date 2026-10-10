import type { DatabaseSync } from "node:sqlite";
import { nowStamp } from "../core/time.ts";
import type { Settings } from "./model.ts";
import type { SettingsPatch } from "./defaults.ts";

/** PB core paramsTable: key/value rows; the settings live under "settings". */
function ensureParams(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _params (id TEXT PRIMARY KEY NOT NULL, value JSON DEFAULT NULL,
    created TEXT DEFAULT '' NOT NULL, updated TEXT DEFAULT '' NOT NULL)`);
}

export function loadSettings(db: DatabaseSync): SettingsPatch | undefined {
  ensureParams(db);
  const row = db.prepare(`SELECT value FROM _params WHERE id = 'settings'`).get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

export function saveSettings(db: DatabaseSync, s: Settings): void {
  ensureParams(db);
  const now = nowStamp();
  db.prepare(
    `INSERT INTO _params (id, value, created, updated) VALUES ('settings', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
  ).run(JSON.stringify(s), now, now);
}
