import { assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const tt_users = defineCollection({ slug: "tt_users", auth: true, fields: [], access: { read: () => true } });
const tt_itens = defineCollection({
  slug: "tt_itens",
  fields: [{ name: "nome", type: "text" }],
  access: { read: () => true, create: () => true },
});
registerCollections(tt_users, tt_itens);

async function setup() {
  const cs = [superusers, tt_users, tt_itens];
  const db = await dbWith(cs);
  const app = createApp({ db, mailer: new MemoryMailer(), collections: cs, adminUiDir: false });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const user = await app.store.collection(tt_users).create(
    { email: "u@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const suToken = await tokenFor(db, "_superusers", su);
  const userToken = await tokenFor(db, "tt_users", user);
  const call = async (method: string, path: string, token = suToken, body?: unknown) => {
    const headers: Record<string, string> = token ? { Authorization: token } : {};
    if (body) headers["content-type"] = "application/json";
    const r = await app.http.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: r.status === 204 ? null : await r.json(), headers: r.headers };
  };
  return { app, call, userToken };
}

Deno.test("traces API: 401 without auth and 403 for a regular user on every route", async () => {
  const t = await setup();
  const id = "a".repeat(32);
  for (
    const [m, p] of [["GET", "/api/traces"], ["GET", "/api/traces/stats"], ["GET", `/api/traces/${id}`], [
      "DELETE",
      "/api/traces",
    ]]
  ) {
    assertEquals((await t.call(m, p, "")).status, 401, `${m} ${p}`);
    assertEquals((await t.call(m, p, t.userToken)).status, 403, `${m} ${p}`);
  }
});

Deno.test("traces API: list, filter, view with logs, stats, truncate; reading never traces itself", async () => {
  const t = await setup();
  const created = await t.call("POST", "/api/collections/tt_itens/records", "", { nome: "a" });
  assertEquals(created.status, 200);
  const traceId = created.headers.get("x-trace-id")!;
  assertEquals((await t.call("GET", "/api/collections/tt_itens/records/nope", "")).status, 404);
  t.app.tracer.flush();

  const list = await t.call("GET", "/api/traces?sort=start");
  assertEquals(list.status, 200);
  assertEquals(list.json.items.map((i: { name: string }) => i.name), [
    "POST /api/collections/:c/records",
    "GET /api/collections/:c/records/:id",
  ]);
  assertEquals(list.json.items[0].traceId, traceId);
  assertEquals(list.json.items[0].spanCount > 2, true);

  const filtered = await t.call("GET", `/api/traces?filter=${encodeURIComponent("name='record.create tt_itens'")}`);
  assertEquals(filtered.json.items.map((i: { traceId: string }) => i.traceId), [traceId]);
  assertEquals((await t.call("GET", `/api/traces?filter=${encodeURIComponent("nope ~~ 1")}`)).status, 400);

  const view = await t.call("GET", `/api/traces/${traceId}`);
  assertEquals(view.status, 200);
  assertEquals(view.json.root.name, "POST /api/collections/:c/records");
  assertEquals(view.json.root.children[0].name, "record.create tt_itens");
  assertEquals(view.json.logs.length, 1);
  assertEquals(view.json.logs[0].data.traceId, traceId);
  assertEquals((await t.call("GET", `/api/traces/${"b".repeat(32)}`)).status, 404);
  assertEquals((await t.call("GET", "/api/traces/not-an-id")).status, 404);

  const stats = await t.call("GET", "/api/traces/stats");
  assertEquals(stats.json.length, 1);
  assertEquals(stats.json[0].total, 2);
  assertEquals(typeof stats.json[0].p95, "number");
  const slowest = await t.call("GET", "/api/traces/stats?groupBy=name");
  assertEquals(slowest.json.length, 2);

  // Attributes keep flat OTel names: the filter reads `attributes.http.request.method` as that one key.
  const byAttr = await t.call(
    "GET",
    `/api/traces?filter=${encodeURIComponent('attributes.http.request.method = "POST"')}`,
  );
  assertEquals(byAttr.json.items.map((i: { traceId: string }) => i.traceId), [traceId]);
  const grouped = await t.call("GET", "/api/traces/stats?groupBy=attribute&key=http.request.method");
  assertEquals(
    grouped.json.map((g: { value: string; total: number }) => [g.value, g.total]).sort(),
    [["GET", 1], ["POST", 1]],
  );
  const grouped404 = await t.call(
    "GET",
    `/api/traces/stats?groupBy=attribute&key=http.response.status_code&filter=${
      encodeURIComponent("attributes.http.response.status_code = 404")
    }`,
  );
  assertEquals(grouped404.json.map((g: { value: number }) => g.value), [404]);
  assertEquals((await t.call("GET", "/api/traces/stats?groupBy=attribute&key=a')--")).status, 400);

  const dash = await t.call("GET", "/api/_denobase/stats");
  assertEquals([dash.json.traces.count24h, dash.json.traces.errors24h], [2, 0]);

  t.app.tracer.flush();
  assertEquals(t.app.traces.listTraces().totalItems, 2, "the traces API and stats did not trace themselves");
  assertEquals((await t.call("DELETE", "/api/traces")).status, 204);
  assertEquals((await t.call("GET", "/api/traces")).json.totalItems, 0);
});

Deno.test("traces settings: PATCH validates the ranges and the tracer follows the saved values", async () => {
  const t = await setup();
  const bad = await t.call("PATCH", "/api/settings", undefined, { traces: { sampleRatio: 2, maxDays: -1 } });
  assertEquals(bad.status, 400);
  assertEquals(Object.keys(bad.json.data.traces).sort(), ["maxDays", "sampleRatio"]);
  const ok = await t.call("PATCH", "/api/settings", undefined, { traces: { enabled: false } });
  assertEquals([ok.status, ok.json.traces.enabled], [200, false]);
  t.app.tracer.flush();
  const before = t.app.traces.listTraces().totalItems;
  const r = await t.call("POST", "/api/collections/tt_itens/records", "", { nome: "b" });
  assertEquals(r.headers.has("x-trace-id"), false);
  t.app.tracer.flush();
  assertEquals(t.app.traces.listTraces().totalItems, before);
});

Deno.test("View logs: the trace's x-trace-id filters GET /api/logs and its stats down to the request's entry", async () => {
  const t = await setup();
  const r = await t.call("GET", "/api/collections/tt_itens/records", t.userToken);
  assertEquals(r.status, 200);
  const traceId = r.headers.get("x-trace-id")!;
  await t.call("GET", "/api/collections/tt_itens/records", ""); // another trace, must not match
  t.app.tracer.flush();

  const filter = encodeURIComponent(`(data.traceId='${traceId}')`);
  const logs = await t.call("GET", `/api/logs?page=1&perPage=50&filter=${filter}&sort=-created`);
  assertEquals(logs.status, 200);
  assertEquals(logs.json.totalItems, 1);
  assertEquals(logs.json.items[0].message, "GET /api/collections/tt_itens/records");
  assertEquals(logs.json.items[0].data.traceId, traceId);
  const stats = await t.call("GET", `/api/logs/stats?filter=${filter}`);
  assertEquals(stats.json.map((s: { total: number }) => s.total), [1]);

  // An authenticated request shows where its time goes: the token check and its user lookup are spans.
  const view = await t.call("GET", `/api/traces/${traceId}`);
  const names: string[] = [];
  const walk = (s: { name: string; attributes: Record<string, unknown>; children: unknown[] }) => {
    names.push(s.name === "db.query" ? `db.query ${s.attributes["db.collection.name"]}` : s.name);
    s.children.forEach((c) => walk(c as typeof s));
  };
  walk(view.json.root);
  assertEquals(names.includes("auth.verify"), true, names.join(", "));
  assertEquals(names.includes("db.query tt_users"), true, names.join(", "));
  assertEquals(view.json.logs.length, 1);
});
