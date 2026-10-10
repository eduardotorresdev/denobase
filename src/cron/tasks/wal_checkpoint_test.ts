import { assert, assertEquals } from "@std/assert";
import { offRequestCheckpoints, openDb } from "../../core/db.ts";
import { maintain, WAL_TRUNCATE_BYTES } from "./maintenance.ts";

const walBytes = (path: string) => Deno.statSync(`${path}-wal`).size;

/** A file db as `serve` opens it, with ~1 page of payload per commit. */
async function servedDb() {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/data.db`;
  const db = offRequestCheckpoints(openDb(path));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (randomblob(3000))");
  const commits = (n: number) => {
    for (let i = 0; i < n; i++) insert.run();
  };
  return { dir, path, db, commits };
}

Deno.test("a commit on the serving connection never checkpoints: the WAL grows past the auto-checkpoint mark", async () => {
  const { dir, path, db, commits } = await servedDb();
  try {
    // SQLite's default auto-checkpoint is 1000 pages: with it on, the WAL would restart near 4 MB.
    commits(2500);
    assert(walBytes(path) > 1000 * 4096 * 2, `wal ${walBytes(path)}`);
    // Nothing was copied back into the db file: every frame is still only in the WAL.
    const [row] = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").all() as { log: number; checkpointed: number }[];
    assert(row.log > 2000);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the worker's checkpoint job keeps the WAL bounded and the off-hours one resets a large WAL", async () => {
  const { dir, path, db, commits } = await servedDb();
  const worker = openDb(path);
  const input = { dbPath: path, auxPath: "" };
  try {
    let max = 0;
    for (let minuto = 0; minuto < 10; minuto++) {
      commits(300);
      await maintain({ ...input, job: "walCheckpoint" }, () => worker, () => worker);
      max = Math.max(max, walBytes(path));
    }
    // 10 x 300 commits; checkpointed each "minute", the WAL is reused from the top instead of holding all of them.
    assert(max < 600 * 4096 * 2, `wal ${max}`);

    commits(Math.ceil(WAL_TRUNCATE_BYTES / 4096) + 500);
    assert(walBytes(path) > WAL_TRUNCATE_BYTES);
    await maintain({ ...input, job: "walTruncate" }, () => worker, () => worker);
    assertEquals(walBytes(path), 0);
  } finally {
    worker.close();
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});
