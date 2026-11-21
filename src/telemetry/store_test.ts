import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { MAX_JSON, Spans } from "./store.ts";
import type { SpanRecord } from "./span.ts";

const HOUR = 3_600_000_000; // µs
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0) * 1000;

let seq = 0;
function span(over: Partial<SpanRecord> & { traceId: string }): SpanRecord {
  seq++;
  return {
    id: seq.toString(16).padStart(16, "0"),
    parentId: "",
    name: "GET /x",
    kind: 1,
    status: 0,
    start: T0,
    duration: 1,
    root: false,
    attributes: {},
    events: [],
    ...over,
  };
}

const tid = (n: number) => n.toString(16).padStart(32, "0");

/** A root plus `children` db spans, children starting after the root. */
function trace(n: number, over: Partial<SpanRecord> = {}, children = 1): SpanRecord[] {
  const root = span({ traceId: tid(n), root: true, ...over });
  const kids = Array.from(
    { length: children },
    (_, i) => span({ traceId: tid(n), parentId: root.id, name: "db.query", kind: 2, start: root.start + 10 + i }),
  );
  return [root, ...kids];
}

Deno.test("store: insertMany keeps whole traces and copies the root name onto every span", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { name: "POST /api/a" }, 2));
  const spans = s.spans(tid(1));
  assertEquals(spans.length, 3);
  assertEquals(spans.map((x) => x.rootName), ["POST /api/a", "POST /api/a", "POST /api/a"]);
  assertEquals(spans[0].created, "2026-01-01 10:00:00.000Z");
});

Deno.test("store: listTraces lists roots only, with span and error counts, newest first", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { start: T0 }, 3));
  const failing = trace(2, { start: T0 + 1000, name: "POST /b" }, 1);
  failing[1].status = 2;
  s.insertMany(failing);
  const r = s.listTraces();
  assertEquals(r.totalItems, 2);
  assertEquals(r.items.map((i) => [i.traceId, i.spanCount, i.errorCount]), [[tid(2), 2, 1], [tid(1), 4, 0]]);
});

Deno.test("store: a filter on child spans finds their traces; PB sort applies to roots", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { duration: 50 }, 0));
  s.insertMany(trace(2, { duration: 10 }, 1));
  s.insertMany(trace(3, { duration: 30, attributes: { "http.route": "/c" } }, 1));
  assertEquals(s.listTraces({ filter: "name='db.query'", sort: "duration" }).items.map((i) => i.traceId), [
    tid(2),
    tid(3),
  ]);
  assertEquals(s.listTraces({ filter: "duration>20", sort: "-duration" }).items.map((i) => i.traceId), [
    tid(1),
    tid(3),
  ]);
  assertEquals(s.listTraces({ perPage: 1, page: 2, sort: "duration" }).items[0].traceId, tid(3));
});

Deno.test("store: getTrace builds the tree by parent, children in start order; unknown parents hang from the root", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  const root = span({ traceId: tid(1), root: true, parentId: "ffffffffffffffff" });
  const a = span({ traceId: tid(1), parentId: root.id, name: "a", start: T0 + 20 });
  const b = span({ traceId: tid(1), parentId: root.id, name: "b", start: T0 + 10 });
  const a1 = span({ traceId: tid(1), parentId: a.id, name: "a1", start: T0 + 30 });
  const orphan = span({ traceId: tid(1), parentId: "eeeeeeeeeeeeeeee", name: "orphan", start: T0 + 40 });
  s.insertMany([a1, root, a, b, orphan]);
  const t = s.getTrace(tid(1))!;
  assertEquals(t.root.id, root.id);
  assertEquals(t.root.children.map((c) => c.name), ["b", "a", "orphan"]);
  assertEquals(t.root.children[1].children.map((c) => c.name), ["a1"]);
  assertEquals(s.getTrace(tid(9)), null);
});

Deno.test("store: stats per hour with errors and nearest-rank percentiles", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  // Hour 10: durations 1..100, two of them failed; hour 11: one trace.
  for (let i = 1; i <= 100; i++) s.insertMany(trace(i, { duration: i, status: i > 98 ? 2 : 0 }, 0));
  s.insertMany(trace(500, { duration: 7, start: T0 + HOUR }, 0));
  assertEquals(s.stats(), [
    { date: "2026-01-01 10:00:00.000Z", total: 100, errors: 2, p50: 50, p95: 95, p99: 99 },
    { date: "2026-01-01 11:00:00.000Z", total: 1, errors: 0, p50: 7, p95: 7, p99: 7 },
  ]);
  assertEquals(s.stats("status=2").map((r) => r.total), [2]);
  assertEquals(s.slowest(undefined, 1)[0].name, "GET /x");
});

Deno.test("store: oversized attributes and events keep only a marker", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  const big = "x".repeat(MAX_JSON);
  s.insertMany([span({
    traceId: tid(1),
    root: true,
    attributes: { big },
    events: [{ name: "e", time: 0, attributes: { big } }],
  })]);
  const [r] = s.spans(tid(1));
  assertEquals(r.attributes, { truncated: true } as never);
  assertEquals(r.events, [{ name: "truncated" }] as never);
});

Deno.test("store: deleteOlderThan drops old spans, truncate drops all, the rollup follows both", async () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { start: T0 }, 1));
  s.insertMany(trace(2, { start: T0 + 2 * HOUR, status: 2, duration: 9 }, 1));
  await s.deleteOlderThan(new Date(T0 / 1000 + 3_600_000));
  assertEquals(s.listTraces().items.map((i) => i.traceId), [tid(2)]);
  assertEquals(s.spans(tid(1)), []);
  const now = new Date(T0 / 1000 + 3 * 3_600_000);
  const o = s.overview(now);
  assertEquals([o.current.total, o.current.errors, o.previous.total], [1, 1, 0]);
  assert(o.current.p95 >= 9 && o.current.p95 < 9 * 1.1, String(o.current.p95));
  s.truncate();
  assertEquals(s.listTraces().totalItems, 0);
  assertEquals(s.overview(now).current.total, 0);
});

Deno.test("store: overall gives the period's percentiles; trimTo keeps the newest rows", async () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  // 19 fast roots in one hour, one 5s root alone in another: the hourly worst p95 would be 5s.
  for (let i = 0; i < 19; i++) s.insertMany([span({ traceId: tid(100 + i), root: true, duration: 10 })]);
  s.insertMany([span({ traceId: tid(200), root: true, duration: 5000, start: T0 + HOUR })]);
  assertEquals([s.overall().total, s.overall().p95], [20, 10]);
  await s.trimTo(5);
  assertEquals(s.spans(tid(200)).length, 1);
  assertEquals(s.listTraces().totalItems, 5);
});

Deno.test("store: overview compares the last 24h with the 24h before, per hour and slowest route first", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  const now = new Date(T0 / 1000 + 30 * 3_600_000);
  s.insertMany(trace(1, { start: T0, duration: 10 })); // 30h ago: the previous day
  s.insertMany(trace(2, { start: T0 + 20 * HOUR, name: "GET /fast", duration: 5 }));
  s.insertMany(trace(3, { start: T0 + 21 * HOUR, name: "GET /slow", duration: 500, status: 2 }));
  s.insertMany(trace(4, { start: T0 + 21 * HOUR + 1, name: "GET /slow", duration: 700 }));
  const o = s.overview(now, 24, 1);
  assertEquals([o.previous.total, o.current.total, o.current.errors], [1, 3, 1]);
  assertEquals(o.hours.map((h) => [h.date, h.total]), [
    ["2026-01-02 06:00:00.000Z", 1],
    ["2026-01-02 07:00:00.000Z", 2],
  ]);
  assertEquals(o.routes.map((r) => [r.name, r.total, r.errors]), [["GET /slow", 2, 1], ["GET /fast", 1, 0]]);
  assert(o.routes[0].p95 >= 700 && o.routes[0].p95 < 770, String(o.routes[0].p95));
  // With the default minimum sample (20 traces), none of these routes ranks.
  assertEquals(s.overview(now).routes, []);
});

Deno.test("store: the rollup counts failed cron runs and leaves the admin UI's own requests out", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  const now = new Date(T0 / 1000 + 2 * 3_600_000);
  s.insertMany(trace(1, { start: T0, name: "cron sync", status: 2 }));
  s.insertMany(trace(2, { start: T0 + 1, name: "GET /api/settings", attributes: { "denobase.admin_ui": true } }));
  const o = s.overview(now, 24, 1);
  assertEquals([o.current.total, o.cronFailed.current], [1, 1]);
  // Still stored and listed: only the home's figures skip it.
  assertEquals(s.listTraces().totalItems, 2);
});

Deno.test("store: a db written before the rollup existed gets it built from its stored roots", () => {
  const db = new DatabaseSync(":memory:");
  const s = new Spans(db);
  s.insertMany(trace(1, { start: T0, duration: 3 }));
  db.exec("DROP TABLE _spans_hourly");
  const reopened = new Spans(db);
  assertEquals(reopened.overview(new Date(T0 / 1000 + 3_600_000)).current.total, 1);
  // Built once: opening again does not count the roots twice.
  assertEquals(new Spans(db).overview(new Date(T0 / 1000 + 3_600_000)).current.total, 1);
});

Deno.test("store: problems lists the newest failed or slow roots, maintenance crons and admin calls only when they failed", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { start: T0, duration: 5 }));
  const admin = { "denobase.admin_ui": true };
  s.insertMany(trace(5, { start: T0 + 2, name: "GET /api/settings", duration: 3000, attributes: admin }));
  s.insertMany(trace(6, { start: T0 + HOUR / 2, name: "GET /api/logs", status: 2, attributes: admin }));
  s.insertMany(trace(4, { start: T0 + 2 * HOUR, name: "cron __denobaseWalCheckpoint__", duration: 1800 }));
  s.insertMany(trace(2, { start: T0 + 1, status: 2 }, 2));
  s.insertMany(trace(3, { start: T0 + HOUR, duration: 2000 }));
  const p = s.problems(new Date(T0 / 1000 - 1), 1000);
  assertEquals(p.map((x) => [x.traceId, x.spanCount]), [[tid(3), 2], [tid(6), 2], [tid(2), 3]]);
});

Deno.test("store: the list counts spans and errors only for the page, by the traceId index", () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  const plans: string[] = [];
  const prepare = s.db.prepare.bind(s.db);
  s.db.prepare = ((sql: string) => {
    if (sql.includes('"errorCount"')) {
      plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...sql.split("?").slice(1).map(() => null)) as {
        detail: string;
      }[]).map((r) => r.detail));
    }
    return prepare(sql);
  }) as typeof s.db.prepare;
  s.listTraces({ filter: "status=2", perPage: 5 });
  // The status index made each root's error count scan every failed span, for every match before LIMIT.
  assert(!plans.some((p) => p.includes("idx_spans_status_created")), plans.join("\n"));
  assert(plans.some((p) => p.includes("idx_spans_trace")), plans.join("\n"));
});
