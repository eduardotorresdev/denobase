import { assert, assertEquals, assertFalse } from "@std/assert";
import { connect, fixture, structured } from "./testkit.ts";

const SUPERUSER_ONLY = ["db_sql", "db_logs", "db_crons_list", "db_crons_run", "db_settings_get", "db_settings_patch"];

Deno.test("access: a regular user does not see superuser tools, resources or prompts", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const tools = (await c.listTools()).tools.map((x) => x.name);
  for (const n of SUPERUSER_ONLY) assertFalse(tools.includes(n), n);
  assert(tools.includes("db_list"));
  const resources = (await c.listResources()).resources.map((r) => r.uri);
  assertFalse(resources.includes("settings://public"));
  const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
  assertEquals(prompts, ["explorar-collection"]);
  await c.close();
});

Deno.test("access: calling a superuser tool as a user is the unknown-tool error, not a hint it exists", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({ name: "db_sql", arguments: { sql: "select 1" } }).catch((e) => e);
  const text = r instanceof Error ? r.message : JSON.stringify(r);
  assert(/not found|unknown/i.test(text), text);
  await c.close();
});

Deno.test("access: the superuser sees every tool (backups absent without a data dir)", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.suToken);
  const tools = (await c.listTools()).tools.map((x) => x.name);
  for (const n of SUPERUSER_ONLY) assert(tools.includes(n), n);
  assertFalse(tools.some((n) => n.startsWith("db_backups")));
  assertEquals(tools, [...tools].sort());
  const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
  assertEquals(prompts, ["auditar-acesso", "explorar-collection", "investigar-erro"]);
  await c.close();
});

Deno.test("access: db_list applies the read rule's Where and never returns hidden fields", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const r = structured(await c.callTool({ name: "db_list", arguments: { collection: "mt_notas" } }));
  const items = r.items as Record<string, unknown>[];
  assertEquals(items.map((i) => i.titulo), ["da ana"]);
  assertFalse("segredo" in items[0]);
  await c.close();
});

Deno.test("access: the superuser lists every record; a denied collection is permissao_negada for a user", async () => {
  const t = await fixture();
  const su = await connect(t.app, t.suToken);
  const all = structured(await su.callTool({ name: "db_list", arguments: { collection: "mt_notas", sort: "titulo" } }));
  assertEquals((all.items as { titulo: string }[]).map((i) => i.titulo), ["da ana", "da bia"]);
  await su.close();
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({ name: "db_list", arguments: { collection: "mt_cofre" } });
  assert(r.isError);
  assertEquals(structured(r).code, "permissao_negada");
  await c.close();
});

Deno.test("access: updating someone else's record is an isError result, and nothing changes", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({
    name: "db_update",
    arguments: { collection: "mt_notas", id: t.notaBia.id, data: { titulo: "hacked" } },
  });
  assert(r.isError);
  assertEquals(structured(r).status, 404);
  assertEquals((await t.app.store.collection("mt_notas").get(t.notaBia.id)).titulo, "da bia");
  const own = await c.callTool({
    name: "db_update",
    arguments: { collection: "mt_notas", id: t.notaAna.id, data: { titulo: "editada" } },
  });
  assertFalse(own.isError);
  assertEquals(structured(own).titulo, "editada");
  await c.close();
});

Deno.test("access: a forbidden write answers isError with permissao_negada", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({ name: "db_create", arguments: { collection: "mt_cofre", data: { valor: 1 } } });
  assert(r.isError);
  assertEquals(structured(r).code, "permissao_negada");
  await c.close();
});

Deno.test("access: collections and schema only show what the user may read; full PB JSON is superuser's", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const list = structured(await c.callTool({ name: "db_collections", arguments: {} }));
  assertEquals((list.items as { name: string }[]).map((i) => i.name), ["mt_notas", "mt_users"]);
  const one = structured(await c.callTool({ name: "db_collections", arguments: { name: "mt_notas", full: true } }));
  assertEquals((one.fields as { name: string }[]).map((f) => f.name), ["titulo", "dono"]);
  assertFalse("listRule" in one);
  const res = await c.readResource({ uri: "schema://collections" });
  assertFalse(JSON.stringify(res).includes("mt_cofre"));
  await c.close();
  const su = await connect(t.app, t.suToken);
  const full = structured(await su.callTool({ name: "db_collections", arguments: { name: "mt_notas", full: true } }));
  assert("listRule" in full);
  await su.close();
});

Deno.test("access: guests are 401 by default and see only 'any' tools with allowGuest", async () => {
  const t = await fixture({ mcp: { allowGuest: true } });
  const c = await connect(t.app);
  const tools = (await c.listTools()).tools.map((x) => x.name);
  assertEquals(tools, ["db_health"]);
  const h = structured(await c.callTool({ name: "db_health", arguments: {} }));
  assertEquals(h.auth, null);
  await c.close();
});
