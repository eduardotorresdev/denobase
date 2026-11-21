import { assert, assertEquals, assertFalse } from "@std/assert";
import { connect, fixture, INITIALIZE, rpc, structured } from "./testkit.ts";

const SUPERUSER_ONLY = ["db_sql", "db_logs", "db_crons_list", "db_crons_run", "db_settings_get", "db_settings_patch"];

Deno.test("access: only superusers use the MCP; a guest is 401, an app user 403 even with an MCP token", async () => {
  const t = await fixture();
  const guest = await rpc(t.app, INITIALIZE, {});
  assertEquals(guest.status, 401);
  assert(guest.headers.get("WWW-Authenticate")?.startsWith("Bearer "));
  for (const token of [t.anaToken, t.anaSession]) {
    const res = await rpc(t.app, INITIALIZE, { Authorization: `Bearer ${token}` });
    // A session token has no MCP audience; either way an app user never gets in.
    assert(res.status === 403 || res.status === 401, String(res.status));
  }
  const user = await rpc(t.app, INITIALIZE, { Authorization: `Bearer ${t.anaToken}` });
  assertEquals(user.status, 403);
  assertEquals((await user.json()).error.message, "Only superusers can use the MCP.");
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: `Bearer ${t.suToken}` })).status, 200);
});

Deno.test("access: app.mcp.token refuses anyone but a superuser", async () => {
  const t = await fixture();
  let err: unknown;
  try {
    await t.app.mcp.token("mt_users", t.ana.id);
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error && /superusers only/.test(err.message));
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

Deno.test("access: the superuser lists every record, hidden fields included (as in PB)", async () => {
  const t = await fixture();
  const su = await connect(t.app, t.suToken);
  const all = structured(await su.callTool({ name: "db_list", arguments: { collection: "mt_notas", sort: "titulo" } }));
  const items = all.items as Record<string, unknown>[];
  assertEquals(items.map((i) => i.titulo), ["da ana", "da bia"]);
  assertEquals(items[0].segredo, "s1");
  const cofre = structured(await su.callTool({ name: "db_list", arguments: { collection: "mt_cofre" } }));
  assertEquals((cofre.items as unknown[]).length, 1);
  await su.close();
});

Deno.test("access: full PB JSON of a collection is there for the superuser", async () => {
  const t = await fixture();
  const su = await connect(t.app, t.suToken);
  const full = structured(await su.callTool({ name: "db_collections", arguments: { name: "mt_notas", full: true } }));
  assert("listRule" in full);
  await su.close();
});
