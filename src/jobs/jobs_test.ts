import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { openDb } from "../core/db.ts";
import { onExternalCommit } from "../core/coherence.ts";
import { collections as registry } from "../core/registry.ts";
import { onRecordEvent, type RecordEvent } from "../engine/events.ts";
import { collectSpans, dbWith } from "../testing/mod.ts";
import { enviados, jb_items, observed } from "./testdata/bootstrap.ts";

const BOOTSTRAP = new URL("./testdata/bootstrap.ts", import.meta.url);

/** An app on file dbs, as serve builds it: the only setup where jobs go to the worker. */
async function fileApp() {
  const dir = await Deno.makeTempDir();
  const db = await dbWith([jb_items], openDb(`${dir}/data.db`));
  const app = createApp({
    db,
    auxDb: openDb(`${dir}/auxiliary.db`),
    dataDir: dir,
    mailer: new MemoryMailer(),
    adminUiDir: false,
  });
  app.jobs.use(BOOTSTRAP);
  observed.hooks.length = 0;
  enviados.length = 0;
  return {
    app,
    dir,
    async [Symbol.asyncDispose]() {
      await app.terminate();
      db.close();
      app.logs.db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Waits until cond holds (events from another thread arrive on the next turns). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("jobs: the worker sets its app up from the bootstrap and writes directly; hooks run in the worker", async () => {
  await using t = await fileApp();
  const out = await t.app.jobs.run({ job: "jb_criar" }, { n: 3 }) as {
    hooks: string[];
    setup: number;
    inWorker: boolean;
  };
  assertEquals([out.inWorker, out.setup, out.hooks], [true, 1, ["worker", "worker", "worker"]]);
  assertEquals(observed.hooks, [], "no hook ran on the main thread");
  assertEquals(await t.app.store.collection(jb_items).count(), 3);
});

Deno.test("jobs: a cache on the main thread sees the worker's commit through data_version", async () => {
  await using t = await fileApp();
  let invalidated = 0;
  const off = onExternalCommit((db) => void (db === t.app.db && invalidated++));
  try {
    await t.app.http.request("/api/health");
    assertEquals(invalidated, 0);
    await t.app.jobs.run({ job: "jb_criar" }, { n: 1 });
    await t.app.http.request("/api/health");
    assertEquals(invalidated, 1, "the next request on the main thread invalidated the cache");
    await t.app.http.request("/api/health");
    assertEquals(invalidated, 1, "and only once per foreign commit");
  } finally {
    off();
  }
});

Deno.test("jobs: settings saved by one thread reach the other's app.settings", async () => {
  await using t = await fileApp();
  const other = createApp({
    db: openDb(`${t.dir}/data.db`),
    auxDb: openDb(`${t.dir}/auxiliary.db`),
    adminUiDir: false,
  });
  try {
    const { saveSettings } = await import("../settings/mod.ts");
    saveSettings(other.db, { ...structuredClone(other.settings), meta: { ...other.settings.meta, appName: "Outro" } });
    await t.app.http.request("/api/health");
    assertEquals(t.app.settings.meta.appName, "Outro");
  } finally {
    await other.terminate();
    other.db.close();
    other.logs.db.close();
  }
});

Deno.test("jobs: listeners on the main thread hear the worker's writes (remote), local-only ones do not", async () => {
  await using t = await fileApp();
  const remote: string[] = [], local: string[] = [];
  const offR = onRecordEvent({
    remote: true,
    changed: (e: RecordEvent) => void (e.db === t.app.db && e.remote && remote.push(e.action)),
    deletedElsewhere: (e) => void (e.db === t.app.db && remote.push(`${e.action}:${e.row?.nome}`)),
  });
  const offL = onRecordEvent({ changed: (e) => void (e.db === t.app.db && local.push(e.action)) });
  try {
    await t.app.jobs.run({ job: "jb_criar" }, { n: 1 });
    await t.app.jobs.run({ job: "jb_apagar" });
    await until(() => remote.length === 2);
    assertEquals(remote, ["create", "delete:i0"]);
    assertEquals(local, []);
  } finally {
    offR();
    offL();
  }
});

Deno.test("jobs: a realtime subscriber on the main thread receives the worker's create and delete", async () => {
  await using t = await fileApp();
  const res = await t.app.http.request("/api/realtime");
  const reader = res.body!.getReader();
  const frames: string[] = [];
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      frames.push(dec.decode(value));
    }
  })();
  await until(() => frames.some((f) => f.includes("PB_CONNECT")));
  const clientId = /"clientId":"(\w+)"/.exec(frames.join(""))![1];
  const sub = await t.app.http.request("/api/realtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, subscriptions: ["jb_items/*"] }),
  });
  assertEquals(sub.status, 204);
  await t.app.jobs.run({ job: "jb_criar" }, { n: 1 });
  await until(() => frames.some((f) => f.includes('"action":"create"')));
  await t.app.jobs.run({ job: "jb_apagar" });
  await until(() => frames.some((f) => f.includes('"action":"delete"')));
  assert(frames.join("").includes('"nome":"i0"'), "the deleted record went out as it was");
  await reader.cancel();
  await pump;
});

Deno.test("jobs: two threads writing at once both succeed (busy_timeout, short transactions)", async () => {
  await using t = await fileApp();
  const main = (async () => {
    for (let i = 0; i < 200; i++) await t.app.store.collection(jb_items).create({ nome: `m${i}` });
  })();
  await Promise.all([main, t.app.jobs.run({ job: "jb_escrever" }, { n: 200, prefixo: "w" })]);
  assertEquals(await t.app.store.collection(jb_items).count(), 400);
});

Deno.test("jobs: a unit declared onMain runs on the main thread, and its span joins the run's trace", async () => {
  await using t = await fileApp();
  const collected = collectSpans(t.app);
  t.app.cron.addJob("jb_enviar", "* * * * *");
  await t.app.cron.get("jb_enviar")!.run();
  assertEquals(enviados, ["oi"]);
  const spans = collected.spans();
  const root = spans.find((s) => s.name === "cron jb_enviar")!;
  const job = spans.find((s) => s.name === "job jb_enviar")!;
  const op = spans.find((s) => s.name === "job.principal jb.enviar")!;
  assertEquals([op.traceId, op.parentId, op.attributes.thread], [root.traceId, job.id, "main"]);
});

Deno.test("jobs: the trace of a cron run holds the worker's spans under one traceId", async () => {
  await using t = await fileApp();
  const collected = collectSpans(t.app);
  t.app.cron.addJob("jb_criar", "*/5 * * * *", { job: "jb_criar" }, () => ({ n: 2 }));
  await t.app.cron.get("jb_criar")!.run("manual");
  const spans = collected.spans();
  const root = spans.find((s) => s.name === "cron jb_criar")!;
  const trace = spans.filter((s) => s.traceId === root.traceId);
  const job = trace.find((s) => s.name === "job jb_criar")!;
  const fase = trace.find((s) => s.name === "criar")!;
  assertEquals(root.attributes["cron.name"], "jb_criar");
  assertEquals(root.attributes["cron.schedule"], "*/5 * * * *");
  assertEquals(root.attributes["cron.trigger"], "manual");
  assertEquals(root.attributes.thread, "main");
  assertEquals([root.attributes["cron.rows_written"], root.attributes["jb.criados"]], [2, 2]);
  assertEquals([job.parentId, job.attributes.thread], [root.id, "worker"]);
  assertEquals([fase.parentId, fase.attributes.thread], [job.id, "worker"]);
  assert(trace.some((s) => s.name === "db.transaction" && s.attributes.thread === "worker"), "worker writes traced");
});

Deno.test("jobs: cron traces are kept whatever the head sampling says", async () => {
  await using t = await fileApp();
  t.app.settings.traces.sampleRatio = 0;
  const collected = collectSpans(t.app);
  t.app.cron.addJob("jb_lento", "* * * * *", { job: "jb_lento" }, () => ({ ms: 1 }));
  await t.app.cron.get("jb_lento")!.run();
  assert(collected.spans().some((s) => s.name === "cron jb_lento"));
});

Deno.test("jobs: a run that finds the previous one still going is skipped", async () => {
  await using t = await fileApp();
  t.app.cron.addJob("jb_lento", "* * * * *", { job: "jb_lento" }, () => ({ ms: 300 }));
  const job = t.app.cron.get("jb_lento")!;
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    const first = job.run();
    await new Promise((r) => setTimeout(r, 20));
    assert(job.running);
    const t0 = performance.now();
    await job.run("manual");
    assert(performance.now() - t0 < 100, "the overlapping run returned at once");
    await first;
  } finally {
    console.warn = warn;
  }
  assertEquals(warned.length, 1);
  assert(warned[0].includes("skipped"));
  assertEquals(job.running, false);
});

Deno.test("jobs: a failing job reports its error", async () => {
  await using t = await fileApp();
  await assertRejects(() => t.app.jobs.run({ job: "jb_falha" }), Error, "falhou no worker");
});

Deno.test("jobs: a worker that crashes fails its run and is replaced for the next one", async () => {
  await using t = await fileApp();
  const err = console.error;
  console.error = () => {};
  try {
    await assertRejects(() => t.app.jobs.run({ job: "jb_crash" }), Error, "job worker crashed");
  } finally {
    console.error = err;
  }
  assertEquals(t.app.jobs.restarts, 1);
  const out = await t.app.jobs.run({ job: "jb_criar" }, { n: 1 }) as { inWorker: boolean };
  assert(out.inWorker);
});

Deno.test("jobs: on a db with no file the job runs inline through the same context", async () => {
  const db = await dbWith([jb_items]);
  const app = createApp({ db, mailer: new MemoryMailer(), adminUiDir: false });
  app.jobs.use(BOOTSTRAP);
  observed.hooks.length = 0;
  try {
    const out = await app.jobs.run({ job: "jb_criar" }, { n: 2 }) as { inWorker: boolean; hooks: string[] };
    assertEquals([out.inWorker, out.hooks], [false, ["main", "main"]]);
  } finally {
    await app.terminate();
  }
});

Deno.test("jobs: the cleanups write internal tables from the worker, which no hook or listener watches", async () => {
  await using t = await fileApp();
  for (const table of ["_logs", "_spans", "_otps", "_oauth_codes", "_oauth_refresh_tokens"]) {
    assert(!registry.some((c) => c.slug === table), `${table} is not a collection`);
  }
  t.app.logs.add(0, "old", {});
  t.app.logs.db.exec(`UPDATE _logs SET created = '2000-01-01 00:00:00.000Z'`);
  t.app.logs.add(0, "new", {});
  const events: string[] = [];
  const off = onRecordEvent({ remote: true, changed: (e) => void events.push(e.collection.slug) });
  try {
    await t.app.cron.get("__pbLogsCleanup__")!.run();
  } finally {
    off();
  }
  assertEquals(t.app.logs.list({}).items.map((l) => l.message), ["new"]);
  assertEquals(events, []);
});

Deno.test("jobs: the backup runs whole in the worker and the main thread keeps ticking", async () => {
  await using t = await fileApp();
  const ins = t.app.db.prepare(`INSERT INTO jb_items (id, created, updated, nome, n) VALUES (?, '', '', ?, 0)`);
  t.app.db.exec("BEGIN");
  for (let i = 0; i < 60_000; i++) ins.run(`r${i}`.padEnd(15, "x"), crypto.randomUUID().repeat(8));
  t.app.db.exec("COMMIT");
  await Deno.mkdir(`${t.dir}/storage`, { recursive: true });
  await Deno.writeTextFile(`${t.dir}/storage/f.txt`, "hi");
  t.app.settings.backups.cron = "* * * * *";
  t.app.settings.backups.cronMaxKeep = 1;
  const { autoBackups } = await import("../backups/auto.ts");
  autoBackups(t.app.cron, t.app.backups, t.app.settings);
  const collected = collectSpans(t.app);
  // Drift monitor: the longest gap between 1 ms timers while the backup runs is how long main was blocked.
  let last = performance.now(), worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  try {
    await t.app.cron.get("__pbAutoBackup__")!.run();
    await new Promise((r) => setTimeout(r, 1100));
    await t.app.cron.get("__pbAutoBackup__")!.run();
  } finally {
    clearInterval(timer);
  }
  const keys = (await t.app.backups!.list()).map((b) => b.key);
  assertEquals(keys.length, 1, "retention kept the newest one");
  const spans = collected.spans();
  const root = spans.filter((s) => s.name === "cron __pbAutoBackup__").at(-1)!;
  const fases = spans.filter((s) => s.traceId === root.traceId && s.name.startsWith("backup."));
  assertEquals(fases.map((s) => s.name), [
    "backup.copia_online",
    "backup.zip",
    "backup.retencao",
  ]);
  assert(fases.every((s) => s.attributes.thread === "worker"));
  assert(Number(root.attributes["backup.zip_bytes"]) > 0);
  console.log(`backup: worst main-thread gap ${worst.toFixed(1)} ms`);
  assert(worst < 50, `the main thread was blocked ${worst.toFixed(1)} ms during the backup`);
});

Deno.test("jobs: DENOBASE_JOBS_INLINE=1 (production rollback) runs the jobs on the main thread again", async () => {
  await using t = await fileApp();
  Deno.env.set("DENOBASE_JOBS_INLINE", "1");
  try {
    const out = await t.app.jobs.run({ job: "jb_criar" }, { n: 1 }) as { inWorker: boolean; hooks: string[] };
    assertEquals([out.inWorker, out.hooks], [false, ["main"]]);
  } finally {
    Deno.env.delete("DENOBASE_JOBS_INLINE");
  }
  assert(t.app.jobs.inWorker);
});
