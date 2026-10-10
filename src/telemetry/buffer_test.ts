import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { MAX_PENDING, Tracer } from "./tracer.ts";
import type { TraceSettings } from "./buffer.ts";
import type { SpanRecord } from "./span.ts";
import { NOOP_SPAN } from "./span.ts";
import { withSpan } from "./context.ts";
import { defaultSettings } from "../settings/defaults.ts";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";

function setup(over: Partial<TraceSettings> = {}) {
  const batches: SpanRecord[][] = [];
  const cfg = { ...defaultSettings().traces, ...over };
  const t = new Tracer({ insertMany: (s) => void batches.push(s) }, () => cfg);
  return { t, batches, cfg };
}

Deno.test("buffer: nothing is written before the root ends; then the trace goes in one batch after the tick", async () => {
  const { t, batches } = setup();
  const root = t.startRoot("root");
  withSpan(root, () => {
    t.startSpan("a").end();
    t.startSpan("b").end();
  });
  assertEquals([t.pending, batches.length], [0, 0]);
  root.end();
  assertEquals([t.pending, batches.length], [3, 0]);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(batches.map((b) => b.length), [3]);
});

Deno.test("buffer: traces ending in the same tick share one write", async () => {
  const { t, batches } = setup();
  for (let i = 0; i < 5; i++) t.startRoot(`r${i}`).end();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(batches.map((b) => b.length), [5]);
});

Deno.test("buffer: past maxSpansPerTrace children are counted on the root instead of kept", async () => {
  const { t } = setup({ maxSpansPerTrace: 3 });
  const out: SpanRecord[] = [];
  const tr = new Tracer({ insertMany: (s) => void out.push(...s) }, () => t.cfg());
  await tr.span("root", undefined, async () => {
    for (let i = 0; i < 5; i++) await tr.span(`c${i}`, undefined, () => {});
  });
  tr.flush();
  assertEquals(out.map((s) => s.name), ["c0", "c1", "root"]);
  assertEquals(out[2].attributes["denobase.spans_dropped"], 3);
});

Deno.test("buffer: past the pending limit whole traces are dropped and counted", () => {
  const { t, batches } = setup();
  // A failing store keeps nothing pending between flushes; block it to fill the queue.
  (t as unknown as { flush: () => void }).flush = () => {};
  for (let i = 0; i < MAX_PENDING; i++) t.startRoot(`r${i}`).end();
  assertEquals([t.pending, t.dropped], [MAX_PENDING, 0]);
  t.startRoot("over").end();
  assertEquals([t.pending, t.dropped], [MAX_PENDING, 1]);
  assertEquals(batches.length, 0);
});

Deno.test("buffer: minDurationMs drops fast children but never the root", async () => {
  const { t, batches } = setup({ minDurationMs: 5 });
  await t.span("root", undefined, async () => {
    await t.span("fast", undefined, () => {});
    await t.span("slow", undefined, () => new Promise((r) => setTimeout(r, 10)));
  });
  t.flush();
  assertEquals(batches[0].map((s) => s.name), ["slow", "root"]);
});

Deno.test("buffer: sampled out traces are dropped unless they failed", async () => {
  const { t, batches } = setup({ sampleRatio: 0 });
  await t.span("ok", undefined, () => {});
  await t.span("bad", undefined, () => t.span("inner", undefined, () => Promise.reject(new Error("x")))).catch(
    () => {},
  );
  t.flush();
  assertEquals(batches.flat().map((s) => s.name), ["inner", "bad"]);
});

Deno.test("buffer: disabled (or maxDays 0) gives the noop span and records nothing", async () => {
  for (const over of [{ enabled: false }, { maxDays: 0 }]) {
    const { t, batches } = setup(over);
    assertEquals(t.startRoot("x"), NOOP_SPAN);
    let ran = false;
    await t.span("root", undefined, async () => {
      await t.span("child", undefined, () => void (ran = true));
      assertEquals(t.current(), null);
    });
    t.flush();
    assertEquals([ran, batches.length], [true, 0]);
  }
});

Deno.test("buffer: the app's terminate() flushes what is pending", async () => {
  const app = createApp({ db: new DatabaseSync(":memory:"), mailer: new MemoryMailer(), adminUiDir: false });
  app.tracer.startRoot("shutdown").end();
  assertEquals(app.tracer.pending, 1);
  await app.terminate();
  assertEquals([app.tracer.pending, app.traces.listTraces().items.map((i) => i.name)], [0, ["shutdown"]]);
});

Deno.test("buffer: spans whose parent was dropped (limit, minDurationMs) hang from the nearest kept ancestor", async () => {
  for (const over of [{ maxSpansPerTrace: 4 }, { minDurationMs: 5 }]) {
    const { t, batches } = setup(over);
    await t.span("root", undefined, async () => {
      // Parents end after their children: these are the ones the limit and the fast filter drop.
      await t.span("tx", undefined, async () => {
        await t.span("create", undefined, async () => {
          await t.span("q1", undefined, () => new Promise((r) => setTimeout(r, 6)));
          await t.span("q2", undefined, () => new Promise((r) => setTimeout(r, 6)));
        });
      });
    });
    t.flush();
    const spans = batches.flat();
    const ids = new Set(spans.map((s) => s.id));
    assertEquals(spans.filter((s) => !s.root && !ids.has(s.parentId)).map((s) => s.name), [], JSON.stringify(over));
  }
});

Deno.test("buffer: an error crossing nested spans is one exception event; ancestors only get status error", async () => {
  const { t, batches } = setup();
  await t.span("root", undefined, () =>
    t.span("mid", undefined, () =>
      t.span("leaf", undefined, () => {
        throw new Error("x");
      }))).catch(() => {});
  t.flush();
  const spans = batches.flat();
  assertEquals(spans.map((s) => [s.name, s.status, s.events.length]), [["leaf", 2, 1], ["mid", 2, 0], ["root", 2, 0]]);
});

Deno.test("buffer: the head decision is made at the root and carried by the span", () => {
  const { t } = setup({ sampleRatio: 0 });
  const r = t.startRoot("r");
  assertEquals(r.sampled, false);
  r.end();
  const { t: t1 } = setup({ sampleRatio: 1 });
  const r1 = t1.startRoot("r", { parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: false } });
  assertEquals(r1.sampled, false);
  r1.end();
});

Deno.test("buffer: error messages on spans lose e-mails and token values", async () => {
  const { t, batches } = setup();
  await t.span("root", undefined, () => {
    throw new Error("bad password for joao@x.com token=abc123");
  }).catch(() => {});
  t.flush();
  const json = JSON.stringify(batches.flat());
  assertEquals([json.includes("joao@x.com"), json.includes("abc123")], [false, false]);
});

Deno.test("buffer: a root may raise its own span cap, and a truncated trace is logged, not silent", async () => {
  const { t } = setup({ maxSpansPerTrace: 3 });
  const out: SpanRecord[] = [];
  const tr = new Tracer({ insertMany: (s) => void out.push(...s) }, () => t.cfg());
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a);
  try {
    await tr.root("longo", { maxSpans: 10 }, async () => {
      for (let i = 0; i < 5; i++) await tr.span(`c${i}`, undefined, () => {});
    });
    assertEquals(warned.length, 0);
    await tr.root("curto", {}, async () => {
      for (let i = 0; i < 5; i++) await tr.span(`c${i}`, undefined, () => {});
    });
  } finally {
    console.warn = warn;
  }
  tr.flush();
  assertEquals(out.filter((s) => /^c\d$/.test(s.name)).length, 5 + 2);
  assertEquals(warned.length, 1);
  assertEquals((warned[0][1] as { root: string; descartados: number }).root, "curto");
  assertEquals((warned[0][1] as { descartados: number }).descartados, 3);
});

Deno.test("tracer.root: a new trace even inside another, linked to the span it started from", async () => {
  const { t } = setup();
  const out: SpanRecord[] = [];
  const tr = new Tracer({ insertMany: (s) => void out.push(...s) }, () => t.cfg());
  let later: Promise<void> | undefined;
  await tr.span("POST /api/chat", undefined, () => {
    later = tr.root("turno", {}, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await tr.span("passo", undefined, () => {});
    });
  });
  await later;
  tr.flush();
  const req = out.find((s) => s.name === "POST /api/chat")!;
  const turno = out.find((s) => s.name === "turno")!;
  assertEquals([turno.root, turno.parentId], [true, ""]);
  assertEquals([turno.attributes["link.trace_id"], turno.attributes["link.span_id"]], [req.traceId, req.id]);
  assertEquals(out.find((s) => s.name === "passo")!.parentId, turno.id, "outlives the request and keeps its children");
});
