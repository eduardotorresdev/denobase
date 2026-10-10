import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../core/db.ts";
import * as migrations from "../../migrations/mod.ts";
import { ensureAuthOriginsTable, ensureOtpTable } from "../../auth/mod.ts";
import { asRollbackJournal, restore, TEMPLATE_DB } from "../../testing/mod.ts";
import { type Command } from "../engine.ts";

export const testDataCommand: Command = {
  name: "test-data",
  usage: "[--check]",
  description: "rebuild (or check) the test template db",
  run: (c) => testData({ check: c.flags.check === true }),
};

/** Schema plus applied migration ids: what makes the template stale, ignoring apply timestamps. */
export function fingerprint(db: DatabaseSync, ms: migrations.Migration[]): string {
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  return JSON.stringify({ schema, applied: [...migrations.status(db, ms).applied].sort() });
}

/** Builds in memory and serializes: no WAL sidecars, and the bytes are what freshDb deserializes. */
export async function buildTemplate(ms: migrations.Migration[]): Promise<DatabaseSync> {
  const db = openDb(":memory:");
  await migrations.up(db, ms);
  ensureOtpTable(db);
  ensureAuthOriginsTable(db);
  return db;
}

/**
 * Rebuilds test_data/data.db: every migration applied and no data, like api/cmd/testdata, so each test
 * seeds what it reads through factories. check=true fails when the file differs from a fresh build.
 */
export async function testData(opts: { check?: boolean }): Promise<void> {
  const ms = await migrations.loadMigrations();
  const built = await buildTemplate(ms);
  try {
    if (opts.check) {
      let current: DatabaseSync;
      try {
        current = restore(asRollbackJournal(await Deno.readFile(TEMPLATE_DB)));
      } catch {
        throw new Error("test_data/data.db missing or unreadable: run `test-data`");
      }
      const stale = fingerprint(current, ms) !== fingerprint(built, ms);
      current.close();
      if (stale) throw new Error("test_data/data.db is stale: run `test-data`");
      console.log("test_data/data.db is up to date");
      return;
    }
    await Deno.mkdir(new URL(".", TEMPLATE_DB), { recursive: true });
    await Deno.writeFile(TEMPLATE_DB, built.serialize());
    console.log("test_data/data.db rebuilt");
  } finally {
    built.close();
  }
}
