import { assert, assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { collectSpans, dbWith } from "../testing/mod.ts";
import { authed } from "./guard.ts";
import type { StoredSpan } from "../telemetry/store.ts";

const tr_pedidos = defineCollection({
  slug: "tr_pedidos",
  fields: [{
    name: "nome",
    type: "text",
    required: true,
    hooks: { beforeChange: [({ value }) => typeof value === "string" ? value.trim() : value] },
  }],
  access: { read: () => true, create: () => true, update: () => true, delete: () => true },
  hooks: {
    afterChange: [({ doc }) => {
      if (doc.nome === "explode") throw new Error("hook exploded");
    }],
  },
});
registerCollections(tr_pedidos);

async function setup(settings: Record<string, unknown> = {}) {
  const db = await dbWith([tr_pedidos]);
  const app = createApp({
    db,
    mailer: new MemoryMailer(),
    adminUiDir: false,
    settings: { batch: { enabled: true }, ...settings },
  });
  return { app, collected: collectSpans(app) };
}

const URL = "/api/collections/tr_pedidos/records";
const post = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown, headers: Record<string, string> = {}) =>
  app.http.request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const named = (spans: StoredSpan[], name: string) => spans.filter((s) => s.name === name);
const one = (spans: StoredSpan[], name: string) => {
  const found = named(spans, name);
  assertEquals(found.length, 1, `${name} in ${spans.map((s) => s.name)}`);
  return found[0];
};

Deno.test("tracing: a record POST is a server root with record, tx, hook and db.query children", async () => {
  const { app, collected } = await setup();
  const res = await post(app, { nome: "  mesa " });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const spans = collected.spans();
  const root = one(spans, "POST /api/collections/:c/records");
  assertEquals([root.root, root.kind, root.parentId, root.status], [true, 1, "", 0]);
  assertEquals(root.attributes["http.route"], "/api/collections/:c/records");
  assertEquals(root.attributes["http.response.status_code"], 200);
  assertEquals(root.attributes["url.path"], URL);
  const create = one(spans, "record.create tr_pedidos");
  assertEquals(create.parentId, root.id);
  const txSpan = one(spans, "db.transaction");
  assertEquals(txSpan.parentId, create.id);
  const fieldHook = one(spans, "hook tr_pedidos.nome.beforeChange");
  const afterHook = one(spans, "hook tr_pedidos.afterChange");
  assertEquals([fieldHook.parentId, afterHook.parentId], [txSpan.id, txSpan.id]);
  const insert = named(spans, "db.query").find((s) => s.attributes["db.operation.name"] === "INSERT")!;
  assertEquals(insert.parentId, txSpan.id);
  assertEquals(insert.kind, 2);
  assertEquals(insert.attributes["db.collection.name"], "tr_pedidos");
  assertEquals(insert.attributes["db.system.name"], "sqlite");
  assert(String(insert.attributes["db.query.text"]).startsWith(`INSERT INTO "tr_pedidos"`));
  assert(spans.every((s) => s.traceId === root.traceId && s.rootName === root.name));
  const r = await app.http.request(URL);
  await r.body?.cancel();
  const list = collected.spans().find((s) => s.name === "record.list tr_pedidos")!;
  const selects = collected.spans().filter((s) => s.parentId === list.id && s.name === "db.query");
  // COUNT, then the page itself.
  assertEquals(selects.map((s) => s.attributes["db.response.returned_rows"]), [undefined, 1]);
});

Deno.test("tracing: an untrusted traceparent is ignored: the client picks neither the trace id nor sampling", async () => {
  const { app, collected } = await setup();
  const res = await post(app, { nome: "x" }, {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  });
  await res.body?.cancel();
  const root = collected.spans().find((s) => s.root)!;
  assertEquals([root.traceId === "4bf92f3577b34da6a3ce929d0e0e4736", root.parentId], [false, ""]);
});

Deno.test("tracing: url.query keeps its keys but masks tokens, codes and filters", async () => {
  const { app, collected } = await setup();
  const res = await app.http.request(`${URL}?filter=email%3D'a%40x.com'&token=abc&page=2`);
  await res.body?.cancel();
  const q = String(collected.spans().find((s) => s.root)!.attributes["url.query"]);
  assertEquals(q, "filter=%5Bredacted%5D&token=%5Bredacted%5D&page=2");
});

Deno.test("tracing: a trusted caller's traceparent is joined and the answer carries the trace", async () => {
  const { app, collected } = await setup({ traces: { trustTraceparent: true } });
  const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const res = await post(app, { nome: "x" }, { traceparent: parent });
  await res.body?.cancel();
  const root = collected.spans().find((s) => s.root)!;
  assertEquals([root.traceId, root.parentId], ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"]);
  assertEquals(res.headers.get("x-trace-id"), root.traceId);
  assertEquals(res.headers.get("traceparent"), `00-${root.traceId}-${root.id}-01`);
});

Deno.test("tracing: the request's activity log carries data.traceId and data.spanId", async () => {
  const { app, collected } = await setup();
  const res = await post(app, { nome: "x" });
  await res.body?.cancel();
  const root = collected.spans().find((s) => s.root)!;
  const [log] = app.logs.list({}).items;
  assertEquals([log.data.traceId, log.data.spanId], [root.traceId, root.id]);
});

Deno.test("tracing: an exception in a hook marks the trace error with the exception event", async () => {
  const { app, collected } = await setup();
  const res = await post(app, { nome: "explode" });
  assertEquals(res.status, 500);
  await res.body?.cancel();
  const spans = collected.spans();
  const hook = one(spans, "hook tr_pedidos.afterChange");
  assertEquals(hook.status, 2);
  assertEquals(hook.events[0].attributes?.["exception.message"], "hook exploded");
  const root = spans.find((s) => s.root)!;
  assertEquals([root.status, root.attributes["http.response.status_code"]], [2, 500]);
  assertEquals(app.traces.listTraces({ filter: "status=2" }).items[0].errorCount >= 2, true);
});

Deno.test("tracing: a 4xx answer is recorded but leaves the root unset", async () => {
  const { app, collected } = await setup();
  const res = await post(app, {});
  assertEquals(res.status, 400);
  await res.body?.cancel();
  const root = collected.spans().find((s) => s.root)!;
  assertEquals([root.status, root.attributes["http.response.status_code"]], [0, 400]);
});

Deno.test("tracing: batch sub-requests are children of one trace, each item is its own server span under the batch root", async () => {
  const { app, collected } = await setup();
  const res = await app.http.request("/api/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ method: "POST", url: URL, body: { nome: "a" } }, { method: "POST", url: URL, body: { nome: "b" } }],
    }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const spans = collected.spans();
  assertEquals(new Set(spans.map((s) => s.traceId)).size, 1);
  assertEquals(spans.filter((s) => s.root).map((s) => s.name), ["POST /api/batch"]);
  const items = spans.filter((s) => s.kind === 1 && !s.root);
  assertEquals(items.map((s) => s.name), ["POST /api/collections/:c/records", "POST /api/collections/:c/records"]);
  assertEquals(spans.some((s) => s.name.startsWith("batch[")), false);
  assertEquals(named(spans, "record.create tr_pedidos").length, 2);
});

Deno.test("tracing: a consumer route gets its declared pattern as the root name", async () => {
  const { app, collected } = await setup();
  app.http.get("/api/custom/:id/total", (c) => c.json({ id: c.req.param("id") }));
  app.http.post("/api/guarded", authed(app, {}, (c) => c.json({})));
  (await app.http.request("/api/custom/42/total")).body?.cancel();
  (await app.http.request("/api/guarded", { method: "POST" })).body?.cancel();
  assertEquals(collected.spans().filter((s) => s.root).map((s) => s.name), [
    "GET /api/custom/:id/total",
    "POST /api/guarded",
  ]);
});

Deno.test("tracing: excluded paths and disabled settings record nothing", async () => {
  const { app, collected } = await setup();
  for (const p of ["/api/health", "/api/logs", "/api/traces", "/api/_denobase/stats"]) {
    (await app.http.request(p)).body?.cancel();
  }
  assertEquals(collected.spans(), []);
  const off = await setup({ traces: { enabled: false } });
  const res = await post(off.app, { nome: "x" });
  await res.body?.cancel();
  assertEquals([off.collected.spans(), res.headers.has("traceparent")], [[], false]);
});
