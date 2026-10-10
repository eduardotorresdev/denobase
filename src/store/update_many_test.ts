import { assertEquals, assertRejects } from "@std/assert";
import { StatementSync } from "node:sqlite";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { beforeCommit } from "../core/db.ts";
import type { Doc, HookArgs } from "../core/types.ts";
import { dbWith } from "../testing/mod.ts";
import { createStore } from "./mod.ts";

/** What the hooks saw, in order. */
const visto: string[] = [];
let commits = 0;

const um_itens = defineCollection({
  slug: "um_itens",
  fields: [
    { name: "nome", type: "text", required: true },
    { name: "nota", type: "number", integer: true, min: 0 },
  ],
  access: { read: () => true },
  hooks: {
    beforeChange: [({ data, originalDoc }: HookArgs) => {
      visto.push(`before ${originalDoc?.nome}->${data.nome ?? originalDoc?.nome}`);
      return data;
    }],
    afterChange: [async ({ req, doc, originalDoc }: HookArgs & { doc: Doc }) => {
      visto.push(`after ${originalDoc?.nota}->${doc.nota}`);
      await beforeCommit(req.db, "um_itens:commit", () => {
        commits++;
      });
    }],
  },
});
registerCollections(um_itens);

async function setup() {
  visto.length = 0;
  commits = 0;
  const db = await dbWith([um_itens]);
  const store = createStore(db);
  const c = store.collection(um_itens);
  const a = await c.create({ nome: "a", nota: 1 });
  const b = await c.create({ nome: "b", nota: 2 });
  visto.length = 0;
  commits = 0;
  return { db, c, a, b };
}

/** The statements run while fn runs. */
async function statements(fn: () => Promise<unknown>): Promise<string[]> {
  const proto = StatementSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const originais = Object.fromEntries(["all", "get", "run"].map((m) => [m, proto[m]]));
  const vistas: string[] = [];
  for (const [m, f] of Object.entries(originais)) {
    proto[m] = function (this: StatementSync, ...a: unknown[]) {
      vistas.push(this.sourceSQL);
      return f.apply(this, a);
    };
  }
  try {
    await fn();
  } finally {
    Object.assign(proto, originais);
  }
  return vistas;
}

Deno.test("updateMany runs every hook per item in order, with the right originalDoc, and commits once", async () => {
  const { c, a, b } = await setup();
  await c.updateMany([{ id: a.id, data: { nota: 10 } }, { id: b.id, data: { nome: "bb", nota: 20 } }]);
  assertEquals(visto, ["before a->a", "after 1->10", "before b->bb", "after 2->20"]);
  assertEquals(commits, 1);
  assertEquals((await c.get(a.id)).nota, 10);
  assertEquals((await c.get(b.id)).nome, "bb");
});

Deno.test("updateMany: the same id twice starts the second item from the first one's write", async () => {
  const { c, a } = await setup();
  await c.updateMany([{ id: a.id, data: { nota: 5 } }, { id: a.id, data: { nota: 6 } }]);
  assertEquals(visto, ["before a->a", "after 1->5", "before a->a", "after 5->6"]);
  assertEquals((await c.get(a.id)).nota, 6);
});

Deno.test("updateMany: a failing item rolls the whole batch back", async () => {
  const { c, a, b } = await setup();
  await assertRejects(() => c.updateMany([{ id: a.id, data: { nota: 7 } }, { id: b.id, data: { nota: -1 } }]));
  assertEquals((await c.get(a.id)).nota, 1);
  assertEquals(commits, 0);
});

Deno.test("updateMany: a missing id is a 404 and nothing is written", async () => {
  const { c, a } = await setup();
  await assertRejects(() => c.updateMany([{ id: a.id, data: { nota: 8 } }, { id: "inexistente", data: { nota: 1 } }]));
  assertEquals((await c.get(a.id)).nota, 1);
});

Deno.test("updateMany reads the originals once instead of once per item", async () => {
  const { c, a, b } = await setup();
  const leituras = (sqls: string[]) => sqls.filter((s) => /^\s*SELECT/i.test(s) && s.includes("um_itens")).length;
  const umAUm = await statements(async () => {
    await c.update(a.id, { nota: 3 });
    await c.update(b.id, { nota: 4 });
  });
  const juntos = await statements(() =>
    c.updateMany([{ id: a.id, data: { nota: 5 } }, { id: b.id, data: { nota: 6 } }])
  );
  // One by one: the original and the presented record per item; together: one read of the originals, then each
  // item's re-read after its write.
  assertEquals(leituras(umAUm), 4);
  assertEquals(leituras(juntos), 3);
});

/** What the afterChangeMany hook saw, one entry per call. */
const lotes: { operation: string; itens: string[] }[] = [];

const um_conjunto = defineCollection({
  slug: "um_conjunto",
  fields: [
    { name: "nome", type: "text", required: true },
    { name: "nota", type: "number", integer: true, min: 0 },
    { name: "obs", type: "text" },
  ],
  access: { read: () => true },
  hooks: {
    afterChangeMany: [async ({ req, operation, items }) => {
      lotes.push({
        operation,
        itens: items.map((it) => `${it.originalDoc?.nota ?? "-"}->${it.doc.nota}:${it.doc.obs}`),
      });
      await beforeCommit(req.db, "um_conjunto:commit", () => {
        commits++;
      });
    }],
  },
});
registerCollections(um_conjunto);

async function setupConjunto() {
  const db = await dbWith([um_conjunto]);
  const c = createStore(db).collection(um_conjunto);
  const a = await c.create({ nome: "a", nota: 1, obs: "x" });
  const b = await c.create({ nome: "b", nota: 2, obs: "y" });
  lotes.length = 0;
  commits = 0;
  return { c, a, b };
}

Deno.test("create and update hand afterChangeMany one item each", async () => {
  lotes.length = 0;
  const db = await dbWith([um_conjunto]);
  const c = createStore(db).collection(um_conjunto);
  const a = await c.create({ nome: "a", nota: 1 });
  await c.update(a.id, { nota: 4 });
  assertEquals(lotes, [{ operation: "create", itens: ["-->1:"] }, { operation: "update", itens: ["1->4:"] }]);
});

Deno.test("updateMany without per-row hooks writes every row in one statement and calls afterChangeMany once", async () => {
  const { c, a, b } = await setupConjunto();
  const sqls = await statements(() =>
    c.updateMany([{ id: a.id, data: { nota: 10 } }, { id: b.id, data: { nota: 20, obs: "" } }])
  );
  assertEquals(sqls.filter((s) => /^\s*(WITH|UPDATE)\b.*UPDATE/is.test(s)).length, 2); // one per set of columns
  assertEquals(lotes, [{ operation: "update", itens: ["1->10:x", "2->20:"] }]);
  assertEquals(commits, 1);
  assertEquals((await c.get(a.id)).nota, 10);
  assertEquals((await c.get(a.id)).obs, "x");
  assertEquals((await c.get(b.id)).obs, "");
});

Deno.test("updateMany in one statement when every row writes the same fields", async () => {
  const { c, a, b } = await setupConjunto();
  const sqls = await statements(() => c.updateMany([{ id: a.id, data: { nota: 7 } }, { id: b.id, data: { nota: 8 } }]));
  assertEquals(sqls.filter((s) => /\bUPDATE\b/i.test(s)).length, 1);
  assertEquals(sqls.filter((s) => s.includes("um_conjunto")).length, 2); // the originals, then the write
});

Deno.test("updateMany in one statement: an invalid row writes nothing and calls no hook", async () => {
  const { c, a, b } = await setupConjunto();
  await assertRejects(() => c.updateMany([{ id: a.id, data: { nota: 9 } }, { id: b.id, data: { nota: -1 } }]));
  assertEquals((await c.get(a.id)).nota, 1);
  assertEquals(lotes, []);
});

Deno.test("updateMany in one statement: a missing id is a 404", async () => {
  const { c, a } = await setupConjunto();
  await assertRejects(() => c.updateMany([{ id: a.id, data: { nota: 9 } }, { id: "inexistente", data: { nota: 1 } }]));
  assertEquals((await c.get(a.id)).nota, 1);
});

Deno.test("updateMany with a repeated id keeps the per-row path: each write chains on the previous", async () => {
  const { c, a } = await setupConjunto();
  await c.updateMany([{ id: a.id, data: { nota: 5 } }, { id: a.id, data: { nota: 6 } }]);
  assertEquals(lotes, [{ operation: "update", itens: ["1->5:x"] }, { operation: "update", itens: ["5->6:x"] }]);
  assertEquals((await c.get(a.id)).nota, 6);
});
