import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { type App, createApp } from "../app.ts";
import { openDb, tx } from "../core/db.ts";
import { fileId, readMarker, removeMarker, writeMarker } from "./restore_marker.ts";
import { createBackup, restoreBackup } from "../backups/ops.ts";
import { saveSettings } from "../settings/mod.ts";
import setup from "./testdata/setup.ts";

/**
 * The queue across real processes (§15): `worker` processes of a consumer program (testdata/main.ts) on one db file,
 * driven by an app in this process that enqueues and reads, as a serve would.
 */

const MAIN = new URL("./testdata/main.ts", import.meta.url).pathname;
const opts = { sanitizeOps: false, sanitizeResources: false };

interface Env {
  dir: string;
  app: App;
  /** Set once a restore run by this app swapped the data dir. */
  restored: boolean;
  workers: Deno.ChildProcess[];
  /** Every pid a test spawned or froze, descendants included: killed in close() even if they outlived a parent. */
  pids: Set<number>;
  close(): Promise<void>;
}

async function env(): Promise<Env> {
  const dir = await Deno.makeTempDir();
  // The producer is a process of the cluster that runs no services (role mcp): its jobs go to the workers, its
  // service calls to the serve.
  const app = createApp({
    db: openDb(`${dir}/data.db`),
    auxDb: openDb(`${dir}/auxiliary.db`),
    role: "mcp",
    dataDir: dir,
    onRestored: () => (e.restored = true),
  });
  await setup(app);
  const workers: Deno.ChildProcess[] = [];
  const e: Env = {
    dir,
    app,
    restored: false,
    workers,
    pids: new Set(),
    async close() {
      // Whatever the test did (a failed assertion included): every process it launched, and their executors, resumed
      // if frozen and killed, so no orphan outlives the test.
      for (const w of workers) for (const pid of await family(w.pid)) e.pids.add(pid);
      for (const pid of e.pids) {
        for (const sig of ["SIGCONT", "SIGKILL"] as const) {
          try {
            Deno.kill(pid, sig);
          } catch { /* gone */ }
        }
      }
      for (const w of workers) await exited(w, "close", 10_000).catch(() => {});
      await app.terminate();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
  return e;
}

/** What each process printed on stdout, by its id (echoed too: a failing test must show why). */
const printed = new Map<string, string>();

function worker(e: Env, id: string, ...flags: string[]): Deno.ChildProcess {
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "worker", "--db", `${e.dir}/data.db`, "--id", id, ...flags],
    // A clean stop gives its jobs back after half a second instead of 30 s (tests stop many).
    env: { DENOBASE_STOP_GRACE_MS: "500" },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  printed.set(id, "");
  void (async () => {
    for await (const chunk of p.stdout.pipeThrough(new TextDecoderStream())) {
      printed.set(id, printed.get(id) + chunk);
      await Deno.stdout.write(new TextEncoder().encode(chunk));
    }
  })().catch(() => {});
  e.workers.push(p);
  return p;
}

/**
 * A backup through the queue, within a deadline: on timeout the error carries the unfinished jobs, so a hang says
 * where it stopped (a run left waiting on the serve's heavy executor would otherwise wait forever).
 */
async function backedUp(e: Env, key: string, ms = 90_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      createBackup(e.app.queue, key),
      new Promise<never>((_, rej) =>
        timer = setTimeout(() => {
          const rows = e.app.db.prepare(
            `SELECT name, status, worker, attempts, error, history FROM _jobs WHERE status IN ('pending', 'running')`,
          ).all();
          rej(new Error(`timed out: backup ${key}; unfinished jobs: ${JSON.stringify(rows)}`));
        }, ms)
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A process's exit, within a deadline: a test never waits on a process forever. */
async function exited(p: Deno.ChildProcess, what: string, ms = 60_000): Promise<Deno.CommandStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.status,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out: ${what} exit`)), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits stretch this much: under a loaded machine (CI, three suites at once) a spawn alone can take seconds. */
const SLACK = 3;

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms * SLACK;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A process and its descendants (Linux /proc). */
async function family(pid: number): Promise<number[]> {
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    try {
      const kids = await Deno.readTextFile(`/proc/${out[i]}/task/${out[i]}/children`);
      out.push(...kids.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch { /* gone */ }
  }
  return out;
}

/** Whether nobody holds the write lock of the db at `path` now (a BEGIN IMMEDIATE that does not wait). */
function writable(path: string): boolean {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

const live = (e: Env, id: string) => () => e.app.queue.health().nodes.some((n) => n.id === id && n.alive);
const runs = (e: Env) =>
  e.app.db.prepare(`SELECT job, pid, at FROM t_runs ORDER BY at`).all() as { job: string; pid: number; at: number }[];
const status = (e: Env, id: string) => e.app.queue.get(id)!.status;
const refused = (e: Env) => {
  e.app.logs.db.exec(`CREATE TABLE IF NOT EXISTS t_refused (job TEXT)`);
  return (e.app.logs.db.prepare(`SELECT job FROM t_refused`).all() as { job: string }[]).map((r) => r.job);
};

Deno.test("two workers claim concurrently and every job runs exactly once", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    worker(e, "w2");
    await until("workers up", () => live(e, "w1")() && live(e, "w2")());
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await e.app.queue.enqueue("t_sleep", { ms: 20 })).id);
    await until("all done", () => ids.every((id) => status(e, id) === "done"), 40_000);
    const r = runs(e);
    assertEquals(r.length, 40);
    assertEquals(new Set(r.map((x) => x.job)).size, 40);
    // Both processes took part (40 jobs of 20 ms over 4 slots each).
    assert(new Set(r.map((x) => x.pid)).size >= 2);
  } finally {
    await e.close();
  }
});

Deno.test("a killed worker's lease expires and another worker takes the job (second attempt)", opts, async () => {
  const e = await env();
  try {
    const w1 = worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_hang");
    await until("w1 runs it", () => status(e, j.id) === "running");
    w1.kill("SIGKILL");
    await exited(w1, "w1 killed");
    worker(e, "w2");
    // leaseMs 1.5 s: w2 reclaims it as attempt 2.
    await until("reclaimed", () => e.app.queue.get(j.id)!.attempts === 2, 30_000);
    const row = e.app.queue.get(j.id)!;
    assertEquals(row.history[0].error?.includes("lease"), true);
  } finally {
    await e.close();
  }
});

Deno.test("a failing job is retried with backoff until it succeeds", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_flaky", { n: 3 });
    await until("done", () => status(e, j.id) === "done", 30_000);
    const row = e.app.queue.get(j.id)!;
    assertEquals(row.attempts, 3);
    assertEquals(row.history.map((h) => !!h.error), [true, true, false]);
    const at = runs(e).map((r) => r.at);
    // backoffMs 200, exponential: no retry earlier than the base delay.
    assert(at[1] - at[0] >= 150 && at[2] - at[1] >= 150, JSON.stringify(at));
  } finally {
    await e.close();
  }
});

Deno.test("a heavy job does not hold back normal jobs; a normal-only worker never takes heavy", opts, async () => {
  const e = await env();
  try {
    worker(e, "wn", "--queues", "normal");
    await until("wn up", live(e, "wn"));
    const h = await e.app.queue.enqueue("t_heavy", { ms: 3_000 });
    const n = await e.app.queue.enqueue("t_sleep", { ms: 10 });
    // Claimed after h was enqueued, by the same claim loop that passed over h.
    await until("normal done", () => status(e, n.id) === "done");
    assertEquals(status(e, h.id), "pending");
    worker(e, "wh", "--queues", "heavy");
    await until("heavy running", () => status(e, h.id) === "running");
    const n2 = await e.app.queue.enqueue("t_sleep", { ms: 10 });
    await until("normal done while heavy runs", () => status(e, n2.id) === "done");
    assertEquals(status(e, h.id), "running");
    await until("heavy done", () => status(e, h.id) === "done");
  } finally {
    await e.close();
  }
});

Deno.test("the scheduler enqueues one job per slot across processes, and never over a running one", opts, async () => {
  const e = await env();
  try {
    const dbPath = `${e.dir}/data.db`;
    // Two serves tick the same minute at once, each from its own process: lastSlot lets one through.
    const tick = (at: number) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", new URL("./testdata/tick.ts", import.meta.url).pathname, dbPath, String(at)],
      }).output();
    const at = Date.parse("2026-10-06T05:00:00Z");
    const [a, b] = await Promise.all([tick(at), tick(at)]);
    assert(a.success && b.success, new TextDecoder().decode(a.stderr) + new TextDecoder().decode(b.stderr));
    const count = () =>
      (e.app.db.prepare(`SELECT COUNT(*) AS n FROM _jobs WHERE schedule = 's'`).get() as { n: number }).n;
    assertEquals(count(), 1);
    // The next minute while that run is still pending: no overlap (dedupe cron:s holds).
    assert((await tick(at + 60_000)).success);
    assertEquals(count(), 1);
    // Once it ran, the following slot enqueues again.
    worker(e, "w1");
    await until(
      "ran",
      () => e.app.db.prepare(`SELECT status FROM _jobs WHERE schedule = 's'`).get()?.status === "done",
    );
    assert((await tick(at + 120_000)).success);
    assertEquals(count(), 2);
  } finally {
    await e.close();
  }
});

Deno.test("an enqueue inside a transaction that rolls back leaves no job; a committed one runs", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    await assertRejects(() =>
      tx(e.app.db, async () => {
        await e.app.queue.enqueue("t_sleep", { ms: 0 }, { dedupe: "rolled" });
        throw new Error("rollback");
      })
    );
    assertEquals(e.app.db.prepare(`SELECT COUNT(*) AS n FROM _jobs WHERE dedupe = 'rolled'`).get(), { n: 0 });
    const j = await tx(e.app.db, () => e.app.queue.enqueue("t_sleep", { ms: 0 }));
    await until("done", () => status(e, j.id) === "done");
  } finally {
    await e.close();
  }
});

Deno.test(
  "workers leave with 75 while a restore marker beats, and wait for it to end before starting",
  opts,
  async () => {
    const e = await env();
    try {
      const w1 = worker(e, "w1");
      await until("w1 up", live(e, "w1"));
      const mark = () =>
        writeMarker(e.dir, {
          key: "b.zip",
          owner: "test",
          pid: Deno.pid,
          host: Deno.hostname(),
          started: Date.now(),
          beat: Date.now(),
        });
      mark();
      const beat = setInterval(mark, 500);
      try {
        assertEquals((await exited(w1, "w1")).code, 75);
        worker(e, "w2");
        // It got as far as the marker and waits there (it says so), not up.
        await until("w2 waits", () => printed.get("w2")!.includes("a restore (b.zip) is running"));
        assert(!live(e, "w2")(), "a worker started during the restore");
        clearInterval(beat);
        removeMarker(e.dir);
        await until("w2 up after the restore", live(e, "w2"));
      } finally {
        clearInterval(beat);
      }
    } finally {
      await e.close();
    }
  },
);

function serveProc(e: Env, ...flags: string[]): Deno.ChildProcess {
  return serveWith(e, {}, ...flags);
}

function serveWith(e: Env, env: Record<string, string>, ...flags: string[]): Deno.ChildProcess {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "serve", "--db", `${e.dir}/data.db`, "--port", String(port), ...flags],
    env: { DENOBASE_UI: "off", DENOBASE_STOP_GRACE_MS: "500", ...env },
    // Shown: a failing test must show why the process did what it did.
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  e.workers.push(p);
  return p;
}

const echoUp = (e: Env) => () =>
  e.app.services.all().some((s) => s.alive && s.name === "t_echo" && s.state === "running" && !!s.addr);

Deno.test(
  "a job in a worker calls the serve's long service directly; its retry hands the same keys to the service",
  opts,
  async () => {
    const e = await env();
    try {
      serveProc(e, "--no-worker");
      await until("serve runs t_echo", echoUp(e));
      worker(e, "w1", "--queues", "normal");
      await until("w1 up", live(e, "w1"));
      const j = await e.app.queue.enqueue("t_call", { text: "oi", fail: true });
      await until("done", () => status(e, j.id) === "done", 30_000);
      assertEquals(e.app.queue.get(j.id)!.attempts, 2);
      const r = runs(e).map((x) => x.job);
      // The service saw the two calls of each try under the same two keys, and deduplicated the retry's.
      assertEquals(r.filter((x) => x.startsWith("say:")), ["say:oi:1", "say:oi:2"]);
      assertEquals(r.filter((x) => x.startsWith(j.id)), [`${j.id}:oi#1:oi#2`, `${j.id}:oi#1:oi#2`]);
    } finally {
      await e.close();
    }
  },
);

Deno.test("no serve runs the service: the call fails at once with service_unavailable", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1", "--queues", "normal");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_call", { text: "oi" });
    await until("failed", () => status(e, j.id) === "failed", 30_000);
    assert(e.app.queue.get(j.id)!.error.includes("No serve is running"), e.app.queue.get(j.id)!.error);
  } finally {
    await e.close();
  }
});

Deno.test("a worker that lost its lease cannot commit: the fence refuses its write", {
  ...opts,
  ignore: Deno.build.os !== "linux",
}, async () => {
  const e = await env();
  try {
    const w1 = worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_write", { ms: 2_500 });
    await until("w1 runs it", () => status(e, j.id) === "running");
    // The whole node frozen (supervisor and executors): no heartbeat, no commit; the lease (1.5 s) lapses and w2
    // takes the job over.
    // Frozen outside a write: a node stopped while holding the db's write lock would block every other node until it
    // wakes (SQLite's single writer), which is not what this test is about.
    const tree = await family(w1.pid);
    for (const pid of tree) e.pids.add(pid);
    for (let tries = 0;; tries++) {
      for (const pid of tree) Deno.kill(pid, "SIGSTOP");
      if (writable(`${e.dir}/data.db`) && writable(`${e.dir}/auxiliary.db`)) break;
      for (const pid of tree) Deno.kill(pid, "SIGCONT");
      if (tries > 50) throw new Error("w1 never left its write");
      await new Promise((r) => setTimeout(r, 20));
    }
    worker(e, "w2");
    await until("w2 took it", () => e.app.queue.get(j.id)!.attempts === 2, 40_000);
    for (const pid of tree) Deno.kill(pid, "SIGCONT");
    await until("done", () => status(e, j.id) === "done", 20_000);
    // w1 woke up and tried its commit: the fence refused it (the job records the refusal outside the fence).
    await until("w1's commit refused", () => refused(e).includes(`${j.id}:1`), 20_000);
    // Only the second try wrote: w1's late commit was rolled back.
    assertEquals(runs(e).map((x) => x.job), [`${j.id}:2`]);
  } finally {
    await e.close();
  }
});

Deno.test(
  "a job opening an auxiliary transaction inside a data one commits both (no fence deadlock)",
  opts,
  async () => {
    const e = await env();
    try {
      worker(e, "w1");
      await until("w1 up", live(e, "w1"));
      const j = await e.app.queue.enqueue("t_nested", {});
      await until("done", () => status(e, j.id) === "done", 20_000);
      assertEquals(runs(e).map((x) => x.job), [`${j.id}:1`]);
    } finally {
      await e.close();
    }
  },
);

Deno.test("an orphaned restore marker stops every claim until a serve checks data.db and clears it", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    // A restore that died 30 s ago: its marker no longer beats.
    const old = Date.now() - 30_000;
    writeMarker(e.dir, { key: "b.zip", owner: "gone", pid: 1, host: "x", started: old, beat: old });
    const j = await e.app.queue.enqueue("t_sleep", { ms: 10 });
    // Two beats of w1 after the marker: its claim rounds (and the beat's own check) have seen it.
    const marked = Date.now();
    await until("w1 beat twice since", () => {
      const n = e.app.queue.health().nodes.find((x) => x.id === "w1");
      return !!n && n.beat > marked + 5_000;
    });
    assertEquals(status(e, j.id), "pending");
    serveProc(e, "--no-worker");
    await until("the serve cleared it", () => readMarker(e.dir) === null, 30_000);
    await until("w1 ran it", () => status(e, j.id) === "done", 20_000);
  } finally {
    await e.close();
  }
});

const done = (e: Env, id: string) => () => ["done", "failed", "canceled"].includes(status(e, id));
const alive = (pid: number) => {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};

Deno.test("an ack that meets a locked db waits for the lock and lands: the job runs once (R1)", opts, async () => {
  const e = await env();
  const lock = openDb(`${e.dir}/data.db`);
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_ok", { ms: 1_000 });
    await until("running", () => status(e, j.id) === "running");
    // Another connection holds the write lock past the executor's busy timeout, while the job ends.
    lock.exec("BEGIN IMMEDIATE");
    await new Promise((r) => setTimeout(r, 13_000));
    lock.exec("COMMIT");
    await until("done", done(e, j.id));
    const r = e.app.queue.get(j.id)!;
    assertEquals([r.status, r.attempts, r.history.length], ["done", 1, 1]);
  } finally {
    try {
      lock.exec("ROLLBACK");
    } catch { /* committed */ }
    lock.close();
    await e.close();
  }
});

Deno.test("a heavy executor whose setup breaks spends no try, and is retried with a backoff (R2)", opts, async () => {
  const e = await env();
  try {
    const p = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, "worker", "--db", `${e.dir}/data.db`, "--id", "w1"],
      env: { T_BROKEN_HEAVY: "1" },
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    e.workers.push(p);
    await until("w1 up", live(e, "w1"));
    const h = await e.app.queue.enqueue("t_heavy", { ms: 10 });
    const n = await e.app.queue.enqueue("t_sleep", { ms: 10 });
    await until("the normal job ran", () => status(e, n.id) === "done");
    // Several launches failed meanwhile: the heavy job is still pending with every try intact.
    await until("three failed launches", () => e.app.queue.get(h.id)!.history.length >= 3, 30_000);
    const r = e.app.queue.get(h.id)!;
    assertEquals([r.status, r.attempts], ["pending", 0]);
    assert(r.history.every((x) => x.error === "Its executor did not start."), JSON.stringify(r.history));
    // The waits grow (1 s, then 2 s, plus each launch's own start-up).
    const [a, b, c] = r.history;
    assert(c.end - b.end > b.end - a.end + 500, `${b.end - a.end} ms, then ${c.end - b.end} ms between launches`);
  } finally {
    await e.close();
  }
});

Deno.test("a bare createApp on a file only enqueues; drain() is refused while nodes are live (R3)", opts, async () => {
  const e = await env();
  const bare = createApp({ db: openDb(`${e.dir}/data.db`), auxDb: openDb(`${e.dir}/auxiliary.db`) });
  try {
    await setup(bare);
    const j = await bare.queue.enqueue("t_sleep", { ms: 10 });
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(status(e, j.id), "pending");
    // No node: drain is the explicit opt-in, and run() runs only the job it asked for.
    const other = await bare.queue.enqueue("t_sleep", { ms: 10 });
    assertEquals(await bare.queue.run("t_ok", { ms: 1 }), "ok");
    assertEquals([status(e, j.id), status(e, other.id)], ["pending", "pending"]);
    await bare.queue.drain();
    assertEquals([status(e, j.id), status(e, other.id)], ["done", "done"]);
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    await assertRejects(() => bare.queue.drain(), Error, "nodes are live");
  } finally {
    await bare.terminate();
    await e.close();
  }
});

Deno.test("a job stuck in synchronous code is killed at its timeout; the executor comes back", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_spin", { ms: 120_000 });
    await until("killed", done(e, j.id), 30_000);
    const r = e.app.queue.get(j.id)!;
    assertEquals([r.status, r.errorCode], ["failed", "timeout"]);
    const n = await e.app.queue.enqueue("t_sleep", { ms: 10 });
    await until("a later job runs", () => status(e, n.id) === "done");
  } finally {
    await e.close();
  }
});

Deno.test(
  "a job that kills the shared executor is given back once, then runs alone: there its crash is its own",
  opts,
  async () => {
    const e = await env();
    try {
      worker(e, "w1");
      await until("w1 up", live(e, "w1"));
      const j = await e.app.queue.enqueue("t_exit", {});
      await until("failed", done(e, j.id), 60_000);
      const r = e.app.queue.get(j.id)!;
      // The shared executor's death gave it back without a try (it might have been another job's fault); in quarantine,
      // in a process of its own, the crash is the job's: the try is spent.
      assertEquals([r.status, r.errorCode, r.requeues, r.attempts], ["failed", "crashed", 1, 1]);
      const pids = runs(e).filter((x) => x.job === j.id).map((x) => x.pid);
      assertEquals([pids.length, new Set(pids).size], [2, 2]);
      const n = await e.app.queue.enqueue("t_sleep", { ms: 10 });
      await until("the shared executor still runs jobs", () => status(e, n.id) === "done");
    } finally {
      await e.close();
    }
  },
);

Deno.test(
  "a rejection nobody handled: alone it fails its job; beside a neighbour both go back quarantined, and only the culprit fails (R6, B2)",
  opts,
  async () => {
    const e = await env();
    try {
      worker(e, "w1");
      await until("w1 up", live(e, "w1"));
      const alone = await e.app.queue.enqueue("t_unhandled", {});
      await until("alone ended", done(e, alone.id));
      assertEquals(status(e, alone.id), "failed");
      assert(e.app.queue.get(alone.id)!.error.includes("lost promise"));

      const neighbour = await e.app.queue.enqueue("t_ok", { ms: 1_500 });
      await until("neighbour running", () => status(e, neighbour.id) === "running");
      const culprit = await e.app.queue.enqueue("t_unhandled", {});
      await until("both ended", () => done(e, neighbour.id)() && done(e, culprit.id)(), 30_000);
      const n = e.app.queue.get(neighbour.id)!, c = e.app.queue.get(culprit.id)!;
      // maxAttempts 1 for both: the neighbour got its try back.
      assertEquals([n.status, n.requeues, c.status, c.requeues], ["done", 1, "failed", 1]);
      assert(c.error.includes("lost promise"), c.error);
    } finally {
      await e.close();
    }
  },
);

Deno.test(
  "cancel reaches a heavy job's signal and its finally runs; a deaf one is killed after the grace (R4)",
  opts,
  async () => {
    const e = await env();
    try {
      worker(e, "w1", "--heavy-concurrency", "2");
      await until("w1 up", live(e, "w1"));
      const w = await e.app.queue.enqueue("t_heavy_wait", {});
      const d = await e.app.queue.enqueue("t_heavy_deaf", {});
      await until("both started", () => runs(e).filter((x) => x.job.endsWith(":start")).length === 2);
      e.app.queue.cancel(w.id);
      await until("canceled", done(e, w.id));
      assertEquals(status(e, w.id), "canceled");
      assert(runs(e).some((x) => x.job === `${w.id}:finally`), "the finally did not run");
      // The deaf one times out at 1 s, ignores the abort, and is killed 5 s later.
      await until("killed", done(e, d.id), 20_000);
      const r = e.app.queue.get(d.id)!;
      assertEquals([r.status, r.errorCode], ["failed", "timeout"]);
    } finally {
      await e.close();
    }
  },
);

Deno.test("an executor orphaned by its supervisor's death dies too, even stuck in synchronous code (R7)", {
  ...opts,
  ignore: Deno.build.os === "windows",
}, async () => {
  const e = await env();
  try {
    const w = worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_block", { ms: 120_000 });
    await until("spinning", () => runs(e).some((x) => x.job === j.id));
    const pid = runs(e).find((x) => x.job === j.id)!.pid;
    assert(pid !== w.pid);
    w.kill("SIGKILL");
    await until("the executor is gone", () => !alive(pid), 10_000);
  } finally {
    await e.close();
  }
});

Deno.test(
  "a real restore: workers leave with 75, the data dir is swapped, and a new worker runs on the restored db",
  opts,
  async () => {
    const e = await env();
    try {
      const w1 = worker(e, "w1");
      await until("w1 up", live(e, "w1"));
      const before = await e.app.queue.enqueue("t_sleep", { ms: 1 });
      await until("before ran", () => status(e, before.id) === "done");
      await backedUp(e, "b.zip");
      const after = await e.app.queue.enqueue("t_sleep", { ms: 1 });
      await until("after ran", () => status(e, after.id) === "done");
      const inode = fileId(`${e.dir}/data.db`);

      await restoreBackup(e.app.queue, e.app.backups!, "b.zip");
      // The restore holds the backups key: no backup starts meanwhile, by any path.
      await assertRejects(() => createBackup(e.app.queue, "c.zip"), Error, "another backup/restore");
      assertEquals((await exited(w1, "w1")).code, 75);
      await until("swapped", () => e.restored, 30_000);
      assert(fileId(`${e.dir}/data.db`) !== inode, "data.db was not swapped");
      assertEquals(readMarker(e.dir), null);

      // A new worker on the restored files: the db is the backup's (only the first run), and it runs jobs.
      worker(e, "w2");
      const db = openDb(`${e.dir}/data.db`);
      try {
        const jobs = () => db.prepare(`SELECT job FROM t_runs`).all().map((r) => (r as { job: string }).job);
        assertEquals(jobs(), [before.id]);
        db.prepare(`INSERT INTO _jobs (id, queue, name, payload, status, runAt, maxAttempts, backoffMs, timeoutMs,
        leaseMs, created, updated) VALUES ('fresh00000000000', 'normal', 't_sleep', '{"ms":1}', 'pending', 0, 1, 0,
        0, 60000, 0, 0)`).run();
        await until("the new worker ran a job", () => jobs().includes("fresh00000000000"), 30_000);
      } finally {
        db.close();
      }
    } finally {
      await e.close();
    }
  },
);

Deno.test("the serve's own scheduler tick enqueues a schedule at its time in meta.timezone", opts, async () => {
  const e = await env();
  try {
    const tz = "America/Sao_Paulo";
    saveSettings(e.app.db, { ...e.app.settings, meta: { ...e.app.settings.meta, timezone: tz } });
    // The next minute (or the one after, to leave the serve time to boot), as a wall clock in that zone: an
    // expression that fires only if the tick reads the zone (UTC is 3 h away).
    const at = new Date(Date.now() + (new Date().getUTCSeconds() < 40 ? 60_000 : 120_000));
    const part = (t: string) =>
      Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, [t]: "numeric", hourCycle: "h23" }).format(at));
    const expr = `${part("minute")} ${part("hour")} * * *`;
    const l = Deno.listen({ port: 0 });
    const port = (l.addr as Deno.NetAddr).port;
    l.close();
    const p = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, "serve", "--db", `${e.dir}/data.db`, "--port", String(port)],
      env: { DENOBASE_UI: "off", T_CRON: expr },
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    e.workers.push(p);
    const ran = () =>
      e.app.db.prepare(`SELECT id, status FROM _jobs WHERE schedule = 't_cron'`).all() as {
        id: string;
        status: string;
      }[];
    await until("the schedule fired", () => ran().some((j) => j.status === "done"), 150_000);
    assertEquals(ran().length, 1);
  } finally {
    await e.close();
  }
});

Deno.test(
  "a bare app's own run() renews its lease: a worker that comes up meanwhile does not run it again (B1)",
  opts,
  async () => {
    const e = await env();
    const bare = createApp({ db: openDb(`${e.dir}/data.db`), auxDb: openDb(`${e.dir}/auxiliary.db`) });
    try {
      await setup(bare);
      // 6 s of work under a 1.5 s lease.
      const ran = bare.queue.run("t_write", { ms: 6_000 });
      await until("running", () => runs(e).length === 0 && bare.queue.list({ status: "running" }).items.length === 1);
      worker(e, "w1");
      await ran;
      const j = bare.queue.list({}).items[0];
      assertEquals([j.status, j.attempts], ["done", 1]);
      assertEquals(runs(e).map((x) => x.job), [`${j.id}:1`]);
    } finally {
      await bare.terminate();
      await e.close();
    }
  },
);

Deno.test("a serve's singleton stays running past a lease TTL, under the node's own id (B3)", opts, async () => {
  const e = await env();
  try {
    serveProc(e, "--no-worker");
    const rows = () =>
      e.app.logs.db.prepare(`SELECT node, state FROM _services WHERE name = 't_echo'`).all() as {
        node: string;
        state: string;
      }[];
    const tableUp = () => {
      try {
        return rows().some((r) => r.state === "running");
      } catch {
        return false;
      }
    };
    await until("running", tableUp, 30_000);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const r = rows();
      assertEquals(r.map((x) => x.state), ["running"]);
      assert(r[0].node.startsWith("serve:"), r[0].node);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await e.close();
  }
});

Deno.test("a job's transaction longer than its lease commits on the first try (S1)", opts, async () => {
  const e = await env();
  try {
    worker(e, "w1");
    await until("w1 up", live(e, "w1"));
    const j = await e.app.queue.enqueue("t_longtx", {});
    await until("ended", done(e, j.id), 30_000);
    const r = e.app.queue.get(j.id)!;
    assertEquals([r.status, r.attempts], ["done", 1]);
    assertEquals(runs(e).map((x) => x.job), [`${j.id}:1`]);
  } finally {
    await e.close();
  }
});

for (const serves of [1, 2]) {
  Deno.test(
    `a restore by a real serve (${serves} serve${
      serves === 1 ? "" : "s"
    }): it restarts with 1, the others with 75, and the data dir is swapped clean (Q1, Q2)`,
    opts,
    async () => {
      const e = await env();
      try {
        const restorer = serveWith(e, { T_RESTORER: "1" });
        const others = Array.from({ length: serves - 1 }, () => serveProc(e));
        const nodes = () => e.app.queue.health().nodes.filter((n) => n.alive && n.kind === "serve").length;
        await until("serves up", () => nodes() === serves, 30_000);
        // A db of some size: the restore outlives a few supervisor ticks, as a real one does.
        e.app.db.exec(`CREATE TABLE t_big (b BLOB)`);
        e.app.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
          INSERT INTO t_big SELECT randomblob(1048576) FROM n`);
        await backedUp(e, "b.zip");
        const inode = fileId(`${e.dir}/data.db`);
        Deno.writeTextFileSync(`${e.dir}/.t_restore`, "b.zip");
        // The restorer exits non-zero (1: PB's restart after a restore); every other serve leaves with 75; both are
        // codes an on-failure restart policy brings back.
        assertEquals((await exited(restorer, "restorer")).code, 1);
        for (const o of others) assertEquals((await exited(o, "other serve")).code, 75);
        assert(fileId(`${e.dir}/data.db`) !== inode, "data.db was not swapped");
        assertEquals(readMarker(e.dir), null);
        const db = openDb(`${e.dir}/data.db`);
        try {
          const held = db.prepare(`SELECT COUNT(*) AS n FROM _jobs WHERE name = '__denobaseRestore__'`).get() as {
            n: number;
          };
          assertEquals(held.n, 0);
        } finally {
          db.close();
        }
      } finally {
        await e.close();
      }
    },
  );
}

for (const kind of ["worker", "serve"] as const) {
  Deno.test(
    `a ${kind} stopped cleanly four times in a row gives its job back each time: no try spent, never \`crashed\``,
    opts,
    async () => {
      const e = await env();
      try {
        const j = await e.app.queue.enqueue("t_sleep", { ms: 600_000 }, { maxAttempts: 1 });
        for (let i = 0; i < 4; i++) {
          const before = e.app.queue.get(j.id)!.history.length;
          const w = kind === "worker" ? worker(e, `w${i}`) : serveProc(e);
          await until(
            `run ${i}`,
            () => status(e, j.id) === "running" && e.app.queue.get(j.id)!.history.length === before,
            30_000,
          );
          w.kill("SIGTERM");
          const st = await exited(w, `stop ${i}`);
          assertEquals(st.code, 0, `stop ${i}: exit ${st.code} ${st.signal ?? ""}`);
          await until(`given back ${i}`, () => status(e, j.id) === "pending");
        }
        const r = e.app.queue.get(j.id)!;
        assertEquals([r.attempts, r.requeues], [0, 0], JSON.stringify(r.history));
        assertEquals(
          r.history.map((h) => h.code),
          ["stopped", "stopped", "stopped", "stopped"],
        );
      } finally {
        await e.close();
      }
    },
  );
}
