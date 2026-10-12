import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, zipSync } from "fflate";
import { Backups } from "./mod.ts";
import { extract } from "./archive.ts";
import { startFakeS3 } from "../testing/mod.ts";
import type { S3Config } from "../settings/model.ts";

const OFF = { enabled: false } as S3Config;

async function dataDir() {
  const dir = await Deno.makeTempDir();
  const db = new DatabaseSync(`${dir}/data.db`);
  const aux = new DatabaseSync(`${dir}/auxiliary.db`);
  db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('original')`);
  await Deno.mkdir(`${dir}/storage`);
  await Deno.writeTextFile(`${dir}/storage/f.txt`, "hi");
  await Deno.writeTextFile(`${dir}/extra.txt`, "kept");
  const close = async () => {
    db.close();
    aux.close();
    await Deno.remove(dir, { recursive: true });
  };
  return { dir, db, aux, close };
}

Deno.test("settings.backups.s3 sends zips to the bucket, prunes there, and restores from it", async () => {
  const s3 = startFakeS3({ minPartSize: 1 });
  const d = await dataDir();
  let restored = 0;
  try {
    const backups = new Backups(d.dir, d.db, d.aux, () => restored++);
    // Files on S3 too: pb_data/storage is a leftover, not the files, so the zip leaves it out (PB).
    backups.use(s3.config, s3.config);
    await backups.create("@auto_a.zip", { prefix: "@auto_", maxKeep: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await backups.create("@auto_b.zip", { prefix: "@auto_", maxKeep: 1 });
    await backups.create("manual.zip");
    assertEquals([...s3.objects.keys()].sort(), ["@auto_b.zip", "manual.zip"]);
    assertEquals((await backups.list()).map((b) => b.key), ["@auto_b.zip", "manual.zip"]);
    const zip = unzipSync(s3.objects.get("manual.zip")!.data);
    assertEquals(Object.keys(zip).sort(), ["auxiliary.db", "data.db", "extra.txt"]);
    await assertRejects(() => backups.create("manual.zip"));
    // Nothing went to the local dir.
    await assertRejects(() => Deno.stat(`${d.dir}/backups/manual.zip`));

    d.db.exec(`UPDATE t SET v = 'changed'`);
    await backups.restore("manual.zip");
    assertEquals(restored, 1);
    const back = new DatabaseSync(`${d.dir}/data.db`, { readOnly: true });
    try {
      assertEquals(back.prepare(`SELECT v FROM t`).get(), { v: "original" });
    } finally {
      back.close();
    }
    assertEquals(await Deno.readTextFile(`${d.dir}/extra.txt`), "kept");

    // Switching back to local applies at once, without rebuilding Backups.
    backups.use(OFF, OFF);
    assertEquals(await backups.list(), []);
  } finally {
    await d.close();
    await s3.close();
  }
});

Deno.test("local files go in the zip with local backups", async () => {
  const d = await dataDir();
  try {
    const backups = new Backups(d.dir, d.db, d.aux, () => {});
    backups.use(OFF, OFF);
    await backups.create("l.zip");
    const zip = unzipSync(await Deno.readFile(`${d.dir}/backups/l.zip`));
    assertEquals(Object.keys(zip).sort(), ["auxiliary.db", "data.db", "extra.txt", "storage/f.txt"]);
    assertEquals((await backups.list()).map((b) => b.key), ["l.zip"]);
  } finally {
    await d.close();
  }
});

Deno.test("streaming extract refuses paths outside the dir and zips without data.db", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bad = `${dir}/bad.zip`;
    await Deno.writeFile(bad, zipSync({ "data.db": new Uint8Array([1]), "../evil": new Uint8Array([2]) }));
    await assertRejects(() => extract(bad, `${dir}/out1`), Error, "invalid path");
    const noDb = `${dir}/nodb.zip`;
    await Deno.writeFile(noDb, zipSync({ "a/b.txt": new TextEncoder().encode("x") }));
    await assertRejects(() => extract(noDb, `${dir}/out2`), Error, "data.db is missing");
    const ok = `${dir}/ok.zip`;
    await Deno.writeFile(ok, zipSync({ "data.db": new Uint8Array([7]), "s/x.txt": new TextEncoder().encode("y") }));
    await extract(ok, `${dir}/out3`);
    assertEquals(await Deno.readTextFile(`${dir}/out3/s/x.txt`), "y");
    assert((await Deno.stat(`${dir}/out3/data.db`)).isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
