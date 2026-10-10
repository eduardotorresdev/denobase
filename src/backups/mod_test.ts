import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { Backups } from "./mod.ts";

Deno.test("create on file dbs zips off the main thread: the loop keeps ticking while it runs", async () => {
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

    const zip = unzipSync(await backups.read("b.zip"));
    assertEquals(Object.keys(zip).sort(), ["auxiliary.db", "data.db", "storage/f.txt"]);
    assertEquals(backups.active, null);
  } finally {
    db.close();
    aux.close();
    await Deno.remove(dir, { recursive: true });
  }
});
