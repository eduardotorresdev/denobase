import { assertEquals } from "@std/assert";
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

Deno.test("store: deleteOlderThan drops old spans, truncate drops all, summary counts the last day", async () => {
  const s = new Spans(new DatabaseSync(":memory:"));
  s.insertMany(trace(1, { start: T0 }, 1));
  s.insertMany(trace(2, { start: T0 + 2 * HOUR, status: 2, duration: 9 }, 1));
  await s.deleteOlderThan(new Date(T0 / 1000 + 3_600_000));
  assertEquals(s.listTraces().items.map((i) => i.traceId), [tid(2)]);
  assertEquals(s.spans(tid(1)), []);
  assertEquals(s.summary(new Date(T0 / 1000)), { count: 1, errors: 1, p95: 9 });
  s.truncate();
  assertEquals(s.listTraces().totalItems, 0);
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
