import { defineSetup } from "../../app.ts";
import { tx } from "../../core/db.ts";
import { restoreBackup } from "../../backups/ops.ts";
import { currentCall, service } from "../../services/mod.ts";

/** A long service of the serve: it counts each call it really runs. */
export const echo = service<{ say(text: string): Promise<string> }>("t_echo");

/** The jobs the process tests drive: each one leaves a trace the test can read in the db. */
export default defineSetup((app) => {
  // A broken deploy, for heavy executors only (R2): the worker itself and its normal executor come up.
  if (Deno.env.get("T_BROKEN_HEAVY") && app.role === "executor" && Deno.args.includes("heavy")) {
    throw new Error("broken setup");
  }
  app.db.exec(`CREATE TABLE IF NOT EXISTS t_runs (job TEXT, node TEXT, pid INT, at INT)`);
  const note = (job: string) =>
    app.db.prepare(`INSERT INTO t_runs VALUES (?, ?, ?, ?)`).run(job, app.queue.nodeId ?? "", Deno.pid, Date.now());
  app.queue.define<{ ms?: number }>("t_sleep", async (ctx) => {
    await new Promise((r) => setTimeout(r, ctx.payload.ms ?? 0));
    note(ctx.job.id);
    await ctx.fence();
  });
  app.queue.define<{ n: number }>("t_flaky", (ctx) => {
    note(ctx.job.id);
    if (ctx.attempt < ctx.payload.n) throw new Error(`attempt ${ctx.attempt}`);
  }, { maxAttempts: 3, backoffMs: 200 });
  app.queue.define<{ ms: number }>("t_heavy", async (ctx) => {
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    note(ctx.job.id);
  }, { queue: "heavy" });
  // Calls the serve's service twice with the same text: the second is a new call (index k); the job's retry sends both
  // again under the same keys, and the service answers them from what it kept.
  app.queue.define<{ text: string; fail?: boolean }>("t_call", async (ctx) => {
    const a = await echo.say(ctx.payload.text);
    const b = await echo.say(ctx.payload.text);
    note(`${ctx.job.id}:${a}:${b}`);
    if (ctx.payload.fail && ctx.attempt === 1) throw new Error("fail after the calls");
  }, { maxAttempts: 2, backoffMs: 50 });
  let n = 0;
  // The pattern for a service with an external effect: it keeps the effect under the call's key, so a retried job
  // gets the first answer back instead of a second effect.
  const done = new Map<string, string>();
  echo.provide(app, {
    say: (text: string) => {
      const key = currentCall()?.idem;
      if (key && done.has(key)) return Promise.resolve(done.get(key)!);
      n++;
      app.db.prepare(`INSERT INTO t_runs VALUES (?, 'svc', ?, ?)`).run(`say:${text}:${n}`, Deno.pid, Date.now());
      const out = `${text}#${n}`;
      if (key) done.set(key, out);
      return Promise.resolve(out);
    },
  });
  // Writes after a pause, in a transaction: the commit guard fences it on the lease.
  app.queue.define<{ ms: number }>("t_write", async (ctx) => {
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    try {
      await tx(app.db, () => note(`${ctx.job.id}:${ctx.attempt}`));
    } catch (e) {
      // Refused by the fence: recorded with a bare statement (no transaction, so no fence), for the test to see.
      app.logs.db.exec(`CREATE TABLE IF NOT EXISTS t_refused (job TEXT)`);
      app.logs.db.prepare(`INSERT INTO t_refused VALUES (?)`).run(`${ctx.job.id}:${ctx.attempt}`);
      throw e;
    }
  }, { leaseMs: 1_500, maxAttempts: 2, backoffMs: 50 });
  // An aux transaction inside a data one: both commits pass the fence (R5).
  app.queue.define("t_nested", async (ctx) => {
    await tx(app.db, async () => {
      note(`${ctx.job.id}:${ctx.attempt}`);
      await tx(app.logs.db, () => {});
    });
  }, { maxAttempts: 1, timeoutMs: 10_000 });
  app.queue.define("t_hang", async (ctx) => {
    note(ctx.job.id);
    // Only the lease ends it: the process is killed under it.
    await new Promise((r) => setTimeout(r, 60_000));
  }, { leaseMs: 1_500, maxAttempts: 2, backoffMs: 50 });
  // A schedule the scheduler test sets through the env (the serve's own tick fires it).
  // T_RESTORER: this serve restores the backup named in <pb_data>/.t_restore once the file shows up, through the same
  // call the admin's restore route makes (a real serve restoring, with its own supervisor watching the marker).
  if (Deno.env.get("T_RESTORER") && app.role === "serve" && app.backups) {
    const backups = app.backups;
    const poll = setInterval(() => {
      let key: string;
      try {
        key = Deno.readTextFileSync(`${backups.dataDir}/.t_restore`).trim();
      } catch {
        return;
      }
      clearInterval(poll);
      Deno.removeSync(`${backups.dataDir}/.t_restore`);
      void restoreBackup(app.queue, backups, key).catch((e) => console.error("t_restore:", e));
    }, 100);
  }
  const cron = Deno.env.get("T_CRON");
  if (cron) app.queue.schedule("t_cron", cron, "t_sleep", { ms: 1 });
  // One transaction longer than its lease (S1): renewed at its BEGIN and its COMMIT, it commits on the first try.
  app.queue.define("t_longtx", async (ctx) => {
    await tx(app.db, async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      note(`${ctx.job.id}:${ctx.attempt}`);
    });
  }, { leaseMs: 1_500, maxAttempts: 2, backoffMs: 50 });
  // Returns after a pause, writing nothing: its ack is the only write (R1).
  app.queue.define<{ ms: number }>("t_ok", async (ctx) => {
    await new Promise((r) => setTimeout(r, ctx.payload.ms));
    return "ok";
  }, { maxAttempts: 1 });
  // Blocks the event loop: no abort, no stdin, no heartbeat from its process reaches it.
  app.queue.define<{ ms: number }>("t_spin", (ctx) => {
    note(ctx.job.id);
    const end = Date.now() + ctx.payload.ms;
    while (Date.now() < end) { /* spin */ }
  }, { maxAttempts: 1, timeoutMs: 1_000 });
  // The same, with no timeout of its own: only its supervisor's death ends it.
  app.queue.define<{ ms: number }>("t_block", (ctx) => {
    note(ctx.job.id);
    const end = Date.now() + ctx.payload.ms;
    while (Date.now() < end) { /* spin */ }
  }, { maxAttempts: 1 });
  // Kills its own executor.
  app.queue.define("t_exit", (ctx) => {
    note(ctx.job.id);
    Deno.exit(3);
  }, { maxAttempts: 1 });
  // Returns fine, but left a rejection nobody handled (R6).
  app.queue.define("t_unhandled", async () => {
    void Promise.reject(new Error("lost promise"));
    await new Promise((r) => setTimeout(r, 50));
  }, { maxAttempts: 1 });
  // Heavy, cooperative: ends on ctx.signal and cleans up in finally (R4).
  app.queue.define("t_heavy_wait", async (ctx) => {
    note(`${ctx.job.id}:start`);
    try {
      await new Promise((r) => ctx.signal.addEventListener("abort", r));
    } finally {
      note(`${ctx.job.id}:finally`);
    }
  }, { queue: "heavy", maxAttempts: 1 });
  // Heavy, deaf to the abort: only the kill after the grace ends it.
  app.queue.define("t_heavy_deaf", async (ctx) => {
    note(`${ctx.job.id}:start`);
    await new Promise((r) => setTimeout(r, 120_000));
  }, { queue: "heavy", maxAttempts: 1, timeoutMs: 1_000 });
});
