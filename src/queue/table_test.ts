/** The _jobs protocol on its own: one connection, a pinned clock, no processes. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  ack,
  cancelJob,
  claimById,
  claimJob,
  Conflict,
  ensureJobsTable,
  fence,
  getJob,
  heartbeat,
  HISTORY_MAX,
  holdKey,
  insertJob,
  MAX_REQUEUES,
  nack,
  type NewJob,
  type Owner,
  release,
  releaseKey,
  removeJob,
  requeue,
  retryJob,
} from "./table.ts";
import type { JobRow } from "./types.ts";

const T = 1_000_000;

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  ensureJobsTable(d);
  return d;
}

const job = (o: Partial<NewJob> = {}): NewJob => ({
  queue: "normal",
  name: "j",
  runAt: T,
  maxAttempts: 3,
  backoffMs: 1_000,
  timeoutMs: 0,
  leaseMs: 10_000,
  ...o,
});

const take = (d: DatabaseSync, now = T, queue: "normal" | "heavy" = "normal", isolate = false) =>
  claimJob(d, { queue, names: ["j"], ...(queue === "normal" ? { isolate } : {}) }, "n1", now);
const own = (r: JobRow): Owner => ({ id: r.id, leaseId: r.leaseId! });
const out = { node: "n1", start: T };

Deno.test("claim takes the due job once, by priority; a future runAt and another queue wait", () => {
  const d = db();
  insertJob(d, job({ runAt: T + 5_000 }), T);
  const low = insertJob(d, job(), T).row;
  const high = insertJob(d, job({ priority: 5 }), T).row;
  insertJob(d, job({ queue: "heavy" }), T);
  assertEquals(take(d)!.id, high.id);
  assertEquals(take(d)!.id, low.id);
  assertEquals(take(d), null);
  const r = getJob(d, high.id)!;
  assertEquals([r.status, r.attempts, r.node, r.leaseUntil], ["running", 1, "n1", T + 10_000]);
});

Deno.test("dedupe keeps one pending or running job per key; a finished one frees it", () => {
  const d = db();
  const a = insertJob(d, job({ dedupe: "k" }), T);
  const b = insertJob(d, job({ dedupe: "k" }), T);
  assertEquals([a.created, b.created, b.row.id], [true, false, a.row.id]);
  const r = take(d)!;
  ack(d, own(r), 1, out, T);
  assert(insertJob(d, job({ dedupe: "k" }), T).created);
});

Deno.test("heartbeat renews and reports a cancel; a stale lease token can renew, ack and fence nothing", () => {
  const d = db();
  insertJob(d, job(), T);
  const r = take(d)!;
  assertEquals(heartbeat(d, own(r), T + 5_000), { cancel: false });
  assertEquals(getJob(d, r.id)!.leaseUntil, T + 15_000);
  cancelJob(d, r.id, T + 6_000);
  assertEquals(heartbeat(d, own(r), T + 6_000), { cancel: true });
  const stale = { id: r.id, leaseId: "other" };
  assertEquals(heartbeat(d, stale, T), null);
  assertEquals(ack(d, stale, 1, out, T), false);
  assertEquals(fence(d, stale, T), false);
});

Deno.test("the fence renews a lapsed lease nobody took, and refuses once another run took it over", () => {
  const d = db();
  insertJob(d, job(), T);
  const r = take(d)!;
  assert(fence(d, own(r), T + 10_001 + 5_000));
  take(d, T + 60_000);
  assertEquals(fence(d, own(r), T + 60_001), false);
});

Deno.test("a lapsed lease is taken over as the next try, with the lost one on the history; on the last try it fails", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 2 }), T);
  const first = take(d)!;
  const second = take(d, T + 10_001)!;
  assertEquals([second.id, second.attempts], [first.id, 2]);
  assert(second.leaseId !== first.leaseId);
  assertEquals(getJob(d, first.id)!.history.map((h) => h.code), ["lease_expired"]);
  // The old owner's ack is refused.
  assertEquals(ack(d, own(first), 1, out, T + 10_002), false);
  // The second try lapses too: no try left, the sweep fails it.
  assertEquals(take(d, T + 30_000), null);
  const end = getJob(d, first.id)!;
  assertEquals([end.status, end.errorCode], ["failed", "lease_expired"]);
});

Deno.test("nack retries after an exponential backoff, then fails with its history", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 2 }), T);
  const r1 = take(d)!;
  assert(nack(d, own(r1), "boom", "handler", out, T));
  const p = getJob(d, r1.id)!;
  assertEquals(p.status, "pending");
  assert(p.runAt >= T + 800 && p.runAt <= T + 1_200, String(p.runAt - T));
  assertEquals(take(d, T + 100), null);
  const r2 = take(d, T + 1_200)!;
  assert(nack(d, own(r2), "boom", "handler", out, T + 1_300));
  const f = getJob(d, r1.id)!;
  assertEquals([f.status, f.errorCode, f.history.map((h) => h.n)], ["failed", "handler", [1, 2]]);
});

Deno.test("requeue gives the try back and quarantines; past the cap it spends a try", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 2 }), T);
  for (let i = 0; i < MAX_REQUEUES; i++) {
    const r = take(d, T, "normal", i > 0)!;
    assert(requeue(d, own(r), "executor killed", out, T, true));
    const p = getJob(d, r.id)!;
    assertEquals([p.status, p.attempts, p.requeues, p.isolate], ["pending", 0, i + 1, true]);
  }
  // Quarantined: only a claim for isolated jobs takes it.
  assertEquals(take(d, T, "normal", false), null);
  const r = take(d, T, "normal", true)!;
  assert(requeue(d, own(r), "executor killed", out, T, true));
  const p = getJob(d, r.id)!;
  assertEquals([p.status, p.attempts, p.requeues], ["pending", 1, MAX_REQUEUES]);
});

Deno.test("release (an executor that never came up) spends no try and waits out the launch backoff", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 1 }), T);
  for (let i = 0; i < 5; i++) {
    const r = take(d, T + i * 2_000)!;
    assert(release(d, own(r), "Its executor did not start.", out, T + i * 2_000, 1_000));
    const p = getJob(d, r.id)!;
    assertEquals([p.status, p.attempts, p.requeues, p.runAt], ["pending", 0, 0, T + i * 2_000 + 1_000]);
  }
});

Deno.test("cancel: pending at once; running is flagged for its supervisor", () => {
  const d = db();
  const a = insertJob(d, job(), T).row;
  insertJob(d, job(), T);
  assertEquals(cancelJob(d, a.id, T)!.status, "canceled");
  const r = take(d)!;
  const c = cancelJob(d, r.id, T)!;
  assertEquals([c.status, c.cancel], ["running", true]);
  assertEquals(removeJob(d, r.id), "running");
  assert(nack(d, own(r), "Canceled.", "canceled_running", out, T, { final: true, status: "canceled" }));
  assertEquals(getJob(d, r.id)!.status, "canceled");
  assert(removeJob(d, r.id));
});

Deno.test("retry starts a failed job over; a key taken meanwhile is a Conflict", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 1, dedupe: "k" }), T);
  const r = take(d)!;
  nack(d, own(r), "boom", "handler", out, T);
  insertJob(d, job({ dedupe: "k" }), T);
  assertThrows(() => retryJob(d, r.id, T), Conflict);
  d.exec(`DELETE FROM _jobs WHERE id <> '${r.id}'`);
  const p = retryJob(d, r.id, T)!;
  assertEquals([p.status, p.attempts, p.error], ["pending", 0, ""]);
});

Deno.test("a held key (the restore) blocks every job on it until released; nobody claims the holder", () => {
  const d = db();
  const h = holdKey(d, "backups", "__restore__", "n1", 60_000, T)!;
  assert(h);
  assertEquals(holdKey(d, "backups", "__restore__", "n2", 60_000, T), null);
  assertEquals(insertJob(d, job({ dedupe: "backups" }), T).created, false);
  assertEquals(claimJob(d, { queue: "normal", names: ["__restore__"], isolate: false }, "n2", T + 1), null);
  releaseKey(d, h.id, null, T);
  assert(insertJob(d, job({ dedupe: "backups" }), T).created);
});

Deno.test("claimById takes only that pending job", () => {
  const d = db();
  insertJob(d, job(), T);
  const b = insertJob(d, job(), T).row;
  assertEquals(claimById(d, b.id, "inline", T)!.id, b.id);
  assertEquals(claimById(d, b.id, "inline", T), null);
});

Deno.test("a clean stop gives the job back as `stopped`, never counted: four in a row spend no try", () => {
  const d = db();
  insertJob(d, job({ maxAttempts: 1 }), T);
  for (let i = 0; i < MAX_REQUEUES + 1; i++) {
    const r = take(d, T + i)!;
    assert(requeue(d, own(r), "The node stopped.", out, T + i, false, true));
  }
  const p = getJob(d, take(d, T + 10)!.id)!;
  // Still its first (and only) try, uncounted, after four deploys; no `crashed` in its history.
  assertEquals([p.status, p.attempts, p.requeues], ["running", 1, 0]);
  assertEquals(p.history.map((h) => h.code), ["stopped", "stopped", "stopped", "stopped"]);
});

Deno.test("history keeps the newest HISTORY_MAX attempts and counts the dropped ones", () => {
  const d = db();
  insertJob(d, job(), T);
  const stops = HISTORY_MAX + 7;
  for (let i = 0; i < stops; i++) assert(requeue(d, own(take(d, T + i)!), `stop ${i}`, out, T + i, false, true));
  const r = getJob(d, take(d, T + stops)!.id)!;
  assertEquals([r.history.length, r.historyDropped], [HISTORY_MAX, 7]);
  // The newest are the ones kept, in order.
  assertEquals([r.history[0].error, r.history.at(-1)!.error], ["stop 7", `stop ${stops - 1}`]);
});
