import type { CollectionConfig } from "../core/types.ts";
import type { Migration, Snapshot } from "./types.ts";
import { configToSnapshot } from "./snapshot.ts";
import { diff } from "./ops.ts";
import { heads, replay, topoSort } from "./graph.ts";
import { refuseMultipleHeads } from "./runner.ts";

/** Migrations on disk: one JSON per migration plus the snapshot cache, in a dir the consumer owns. */

/** Dir with migration files and schema.snapshot.json; owned by the consumer, set through setMigrationsDir. */
export let MIGRATIONS_DIR: URL = new URL("./migrations/", `file://${Deno.cwd()}/`);

/** Default params read MIGRATIONS_DIR at call time, so this reaches every function that omits dir. */
export function setMigrationsDir(dir: URL): void {
  MIGRATIONS_DIR = dir;
}
const SNAPSHOT_FILE = "schema.snapshot.json";

export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const out: Migration[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".json") || e.name === SNAPSHOT_FILE) continue;
      const m = JSON.parse(await Deno.readTextFile(new URL(e.name, dir))) as Migration;
      if (`${m.id}.json` !== e.name) throw new Error(`migration file ${e.name} has id ${m.id}; name it ${m.id}.json`);
      out.push(m);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return topoSort(out);
}

/** Sortable id; random suffix keeps ids unique when two branches create migrations in the same second. */
function newMigrationId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rnd = crypto.getRandomValues(new Uint8Array(3));
  return `${ts}_${Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function writeMigration(m: Migration, dir: URL): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(new URL(`${m.id}.json`, dir), JSON.stringify(m, null, 2) + "\n");
}

/** Writes a migration with diff(replay, config) and parents=[current head]; null when no changes. */
export async function create(cs: CollectionConfig[], dir: URL = MIGRATIONS_DIR): Promise<Migration | null> {
  const ms = await loadMigrations(dir);
  refuseMultipleHeads(ms);
  const ops = diff(replay(ms), configToSnapshot(cs));
  if (!ops.length) return null;
  const m: Migration = { id: newMigrationId(), parents: heads(ms), ops };
  await writeMigration(m, dir);
  await writeSnapshot(replay([...ms, m]), dir);
  return m;
}

/** Writes merge migration parents=heads with diff(replayed union, config); regenerates snapshot. */
export async function reconcile(cs: CollectionConfig[], dir: URL = MIGRATIONS_DIR): Promise<Migration | null> {
  const ms = await loadMigrations(dir);
  const hs = heads(ms);
  if (hs.length < 2) {
    await writeSnapshot(replay(ms), dir);
    return null;
  }
  // A merge is written even with no ops: its only job may be joining the heads.
  const m: Migration = { id: newMigrationId(), parents: hs, ops: diff(replay(ms), configToSnapshot(cs)) };
  await writeMigration(m, dir);
  await writeSnapshot(replay([...ms, m]), dir);
  return m;
}

export async function writeSnapshot(s: Snapshot, dir: URL = MIGRATIONS_DIR): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(new URL(SNAPSHOT_FILE, dir), JSON.stringify(s, null, 2) + "\n");
}
