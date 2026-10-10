import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { beforeCommit, tx } from "../core/db.ts";
import { currentTrace } from "./context.ts";
import { Tracer } from "./tracer.ts";
import { traced } from "./instrument/child.ts";
import type { SpanRecord } from "./span.ts";
import { defaultSettings } from "../settings/defaults.ts";

function tracer() {
  const out: SpanRecord[] = [];
  const t = new Tracer({ insertMany: (s) => void out.push(...s) }, () => defaultSettings().traces);
  return { t, out: () => (t.flush(), out) };
}

const byName = (spans: SpanRecord[], name: string) => spans.find((s) => s.name === name)!;

Deno.test("context: spans nest through awaits and Promise.all branches", async () => {
  const { t, out } = tracer();
  await t.span("root", { a: 1 }, async () => {
    await t.span("first", undefined, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await t.span("deep", undefined, () => {});
    });
    await Promise.all([
      t.span("left", undefined, async () => await new Promise((r) => setTimeout(r, 2))),
      t.span("right", undefined, async () => await t.span("right.child", undefined, () => {})),
    ]);
  });
  const s = out();
  const root = byName(s, "root");
  assertEquals(root.root, true);
  assertEquals(root.parentId, "");
  assertEquals(root.attributes, { a: 1 });
  assertEquals(byName(s, "first").parentId, root.id);
  assertEquals(byName(s, "deep").parentId, byName(s, "first").id);
  assertEquals(byName(s, "left").parentId, root.id);
  assertEquals(byName(s, "right").parentId, root.id);
  assertEquals(byName(s, "right.child").parentId, byName(s, "right").id);
  assertEquals(new Set(s.map((x) => x.traceId)).size, 1);
});

Deno.test("context: concurrent traces never see each other's spans", async () => {
  const { t, out } = tracer();
  const seen: Record<string, string> = {};
  await Promise.all(["a", "b", "c"].map((k) =>
    t.span(`req ${k}`, undefined, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      seen[k] = currentTrace()!.traceId;
      await t.span(`child ${k}`, undefined, () => {});
    })
  ));
  const s = out();
  assertEquals(new Set(Object.values(seen)).size, 3);
  for (const k of ["a", "b", "c"]) {
    assertEquals(byName(s, `child ${k}`).traceId, seen[k]);
    assertEquals(byName(s, `child ${k}`).parentId, byName(s, `req ${k}`).id);
  }
  assertEquals(currentTrace(), null);
});

Deno.test("context: lives alongside tx(): queries in a transaction nest under its db.transaction span", async () => {
  const { t, out } = tracer();
  const db = new DatabaseSync(":memory:");
  await t.span("root", undefined, async () => {
    await tx(db, async () => {
      await traced("inside", {}, () => {});
      await tx(db, () => traced("nested", {}, () => {}));
    });
  });
  const s = out();
  const txs = s.filter((x) => x.name === "db.transaction");
  assertEquals(txs.length, 2);
  const outer = txs.find((x) => x.attributes["db.tx.savepoint"] === false)!;
  const inner = txs.find((x) => x.attributes["db.tx.savepoint"] === true)!;
  assertEquals(outer.parentId, byName(s, "root").id);
  assertEquals(byName(s, "inside").parentId, outer.id);
  assertEquals(inner.parentId, outer.id);
  assertEquals(byName(s, "nested").parentId, inner.id);
  assertEquals(typeof outer.attributes["db.tx.wait_ms"], "number");
});

Deno.test("context: beforeCommit work runs in a db.beforeCommit span under its transaction", async () => {
  const { t, out } = tracer();
  const db = new DatabaseSync(":memory:");
  await t.span("root", undefined, async () => {
    await tx(db, async () => {
      await beforeCommit(db, "resumo", () => traced("recalc", {}, () => {}));
    });
  });
  const s = out();
  const tx0 = byName(s, "db.transaction");
  const bc = byName(s, "db.beforeCommit");
  assertEquals(bc.parentId, tx0.id);
  assertEquals(bc.attributes["db.before_commit.key"], "resumo");
  assertEquals(byName(s, "recalc").parentId, bc.id);
});

Deno.test("context: a thrown error is recorded on the span, marks it error and is rethrown", async () => {
  const { t, out } = tracer();
  let caught: unknown;
  try {
    await t.span("root", undefined, () =>
      t.span("boom", undefined, () => {
        throw new Error("kaput");
      }));
  } catch (e) {
    caught = e;
  }
  assertEquals((caught as Error).message, "kaput");
  const boom = byName(out(), "boom");
  assertEquals(boom.status, 2);
  assertEquals(boom.events[0].name, "exception");
  assertEquals(boom.events[0].attributes?.["exception.message"], "kaput");
});

Deno.test("context: a 4xx refusal is recorded but leaves the span unset", async () => {
  const { t, out } = tracer();
  const refusal = Object.assign(new Error("nope"), { status: 403 });
  await t.span("root", undefined, () => t.span("guard", undefined, () => Promise.reject(refusal))).catch(() => {});
  const guard = byName(out(), "guard");
  assertEquals([guard.status, guard.events[0].name], [0, "exception"]);
});

Deno.test("context: work left running after its span ended still joins the trace under an open ancestor", async () => {
  const { t, out } = tracer();
  let late: Promise<unknown> | undefined;
  await t.span("root", undefined, async () => {
    await t.span("hook", undefined, () => {
      late = new Promise((r) => setTimeout(r, 1)).then(() => t.span("publish", undefined, () => {}));
    });
    await late;
  });
  const s = out();
  assertEquals(byName(s, "publish").parentId, byName(s, "root").id);
});
