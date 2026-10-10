import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { dbPath, runTask } from "./mod.ts";
import { Cron } from "../cron/mod.ts";
import { Logs } from "../logs/mod.ts";
import maintenanceTask from "../cron/tasks/maintenance.ts";

const TASK = new URL("./testdata/tasks.ts", import.meta.url);
const MAINTENANCE = new URL("../cron/tasks/maintenance.ts", import.meta.url);

Deno.test("runTask returns the task result, transfers bytes and turns a throw into a rejection", async () => {
  assertEquals(await runTask<string>(TASK, { value: "x" }), "echo:x");
  await assertRejects(() => runTask(TASK, { fail: true }), Error, "task failed on purpose");
  await assertRejects(() => runTask(new URL("./testdata/missing.ts", import.meta.url), {}));
});

Deno.test("a busy task leaves the main thread free", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const out = await runTask<Uint8Array>(TASK, { spin: 300 });
  clearInterval(timer);
  assertEquals(new TextDecoder().decode(out), "spun");
  assert(ticks > 10, `main thread ticked ${ticks} times`);
});

Deno.test("dbPath knows a file db and refuses an in-memory one", async () => {
  const dir = await Deno.makeTempDir();
  const file = new DatabaseSync(`${dir}/a.db`);
  assert(dbPath(file)!.endsWith("/a.db"));
  assertEquals(dbPath(new DatabaseSync(":memory:")), null);
  file.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("cron addTask runs each tick in a worker, with input computed at run time", async () => {
  const dir = await Deno.makeTempDir();
  const aux = new DatabaseSync(`${dir}/auxiliary.db`);
  aux.exec("PRAGMA journal_mode = WAL;");
  const logs = new Logs(aux);
  logs.add(0, "old", {});
  aux.exec(`UPDATE _logs SET created = '2000-01-01 00:00:00.000Z'`);
  logs.add(0, "new", {});
  const data = new DatabaseSync(`${dir}/data.db`);
  let maxDays = 0;
  const cron = new Cron();
  cron.addTask("cleanup", "* * * * *", MAINTENANCE, () => ({
    job: "logsCleanup",
    dbPath: dbPath(data),
    auxPath: dbPath(aux),
    maxDays,
  }));
  await cron.tick(new Date());
  assertEquals(logs.list({}).totalItems, 2); // maxDays 0 keeps everything
  maxDays = 5;
  await cron.tick(new Date());
  assertEquals(logs.list({}).items.map((l) => l.message), ["new"]);
  aux.close();
  data.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("maintenance task optimizes and drops expired OTPs on its own connections", async () => {
  const dir = await Deno.makeTempDir();
  const data = new DatabaseSync(`${dir}/data.db`);
  data.exec(`CREATE TABLE _otps (id TEXT PRIMARY KEY, collection TEXT NOT NULL, recordId TEXT NOT NULL,
    codeHash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, created TEXT NOT NULL)`);
  data.prepare(`INSERT INTO _otps VALUES ('a','u','r','h',0,?,''), ('b','u','r','h',0,?,'')`).run(
    1,
    Date.now() + 60_000,
  );
  const input = { dbPath: `${dir}/data.db`, auxPath: `${dir}/auxiliary.db` };
  await runTask(MAINTENANCE, { ...input, job: "otpCleanup" });
  await runTask(MAINTENANCE, { ...input, job: "dbOptimize" });
  maintenanceTask({ ...input, job: "logsCleanup", maxDays: 1 });
  assertEquals(data.prepare(`SELECT id FROM _otps`).all().map((r) => r.id), ["b"]);
  data.close();
  await Deno.remove(dir, { recursive: true });
});
