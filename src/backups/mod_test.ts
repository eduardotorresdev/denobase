import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { Backups } from "./mod.ts";
import { readAll } from "../files/storage.ts";
import { createApp } from "../app.ts";
import { openDb } from "../core/db.ts";
import { holdKey } from "../queue/table.ts";
import { writeMarker } from "../queue/restore_marker.ts";
import { activeBackup } from "./ops.ts";
import { BACKUPS_KEY, RESTORE_JOB } from "./auto.ts";

Deno.test("create on file dbs streams the zip: the loop keeps ticking while it runs", async () => {
  const dir = await Deno.makeTempDir();
  const db = new DatabaseSync(`${dir}/data.db`);
  const aux = new DatabaseSync(`${dir}/auxiliary.db`);
  try {
    db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT)`);
    aux.exec(`PRAGMA journal_mode = WAL`);
    const ins = db.prepare(`INSERT INTO t VALUES (?)`);
    db.exec("BEGIN");
    for (let i = 0; i < 20_000; i++) ins.run(crypto.randomUUID().repeat(4));
    db.exec("COMMIT");
    await Deno.mkdir(`${dir}/storage`);
    await Deno.writeTextFile(`${dir}/storage/f.txt`, "hi");

    const backups = new Backups(dir, db, aux, () => {});
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await backups.create("b.zip");
    clearInterval(timer);
    assert(ticks > 0, "the event loop was blocked for the whole backup");

    const zip = unzipSync(await readAll((await backups.get("b.zip"))!.body));
    assertEquals(Object.keys(zip).sort(), ["auxiliary.db", "data.db", "storage/f.txt"]);
  } finally {
    db.close();
    aux.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a restore row whose process died frees the backups key; a live one keeps it (B5)", async () => {
  const dir = await Deno.makeTempDir();
  const app = createApp({ db: openDb(":memory:"), dataDir: dir });
  try {
    const old = Date.now() - 60_000;
    const held = holdKey(app.db, BACKUPS_KEY, RESTORE_JOB, "gone", 6 * 3_600_000, old)!;
    // Its marker still beats: the restore is alive.
    writeMarker(dir, { key: "b.zip", owner: "gone", pid: 1, host: "x", started: old, beat: Date.now() });
    assertEquals(activeBackup(app.queue)?.id, held.id);
    // The marker stopped beating (or is gone): the key is free again.
    writeMarker(dir, { key: "b.zip", owner: "gone", pid: 1, host: "x", started: old, beat: old });
    assertEquals(activeBackup(app.queue), null);
    assertEquals(app.queue.get(held.id)!.status, "failed");
  } finally {
    await app.terminate();
    await Deno.remove(dir, { recursive: true });
  }
});
