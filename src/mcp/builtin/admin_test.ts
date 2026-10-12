import { assert, assertEquals, assertFalse } from "@std/assert";
import { connect, fixture, structured } from "../testkit.ts";

Deno.test("admin: db_sql reads, refuses writes and caps rows", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.suToken);
  const r = structured(
    await c.callTool({ name: "db_sql", arguments: { sql: "SELECT titulo FROM mt_notas ORDER BY titulo" } }),
  );
  assertEquals(r.rows, [["da ana"], ["da bia"]]);
  const capped = structured(
    await c.callTool({ name: "db_sql", arguments: { sql: "SELECT titulo FROM mt_notas", maxRows: 1 } }),
  );
  assertEquals([(capped.rows as unknown[]).length, capped.truncated], [1, true]);
  const w = await c.callTool({ name: "db_sql", arguments: { sql: "DELETE FROM mt_notas" } });
  assert(w.isError);
  assertEquals(await t.app.store.collection("mt_notas").count(), 2);
  // The in-memory path (no file for the guard's worker) refuses system tables too.
  const sys = await c.callTool({ name: "db_sql", arguments: { sql: "SELECT tokenKey, password FROM _superusers" } });
  assert(sys.isError);
  assertFalse(JSON.stringify(sys).includes("$2"));
  await c.close();
});

Deno.test("admin: settings never carry secrets; a patch is validated and saved", async () => {
  const t = await fixture({ settings: { smtp: { password: "segredo-smtp" } } as never });
  const c = await connect(t.app, t.suToken);
  const s = await c.callTool({ name: "db_settings_get", arguments: {} });
  assertFalse(JSON.stringify(s).includes("segredo-smtp"));
  const res = await c.readResource({ uri: "settings://public" });
  assertFalse(JSON.stringify(res).includes("segredo-smtp"));
  const p = await c.callTool({ name: "db_settings_patch", arguments: { patch: { meta: { appName: "Fabrica" } } } });
  assertFalse(p.isError);
  assertEquals(t.app.settings.meta.appName, "Fabrica");
  await c.close();
});

Deno.test("admin: crons list and run; logs list and stats", async () => {
  const t = await fixture();
  let ran = 0;
  t.app.cron.add("mt_job", "0 0 * * *", () => void ran++);
  const c = await connect(t.app, t.suToken);
  const jobs = structured(await c.callTool({ name: "db_crons_list", arguments: {} }));
  assert((jobs.items as { id: string }[]).some((j) => j.id === "mt_job"));
  await c.callTool({ name: "db_crons_run", arguments: { id: "mt_job" } });
  // The run may complete after the tool returns; poll instead of a fixed delay.
  for (let i = 0; i < 200 && ran === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assertEquals(ran, 1);
  const missing = await c.callTool({ name: "db_crons_run", arguments: { id: "nope" } });
  assertEquals(structured(missing).status, 404);
  const logs = structured(
    await c.callTool({ name: "db_logs", arguments: { op: "list", filter: "data.type = 'mcp'" } }),
  );
  assert((logs.totalItems as number) >= 2);
  const stats = structured(await c.callTool({ name: "db_logs", arguments: { op: "stats" } }));
  assert(Array.isArray(stats.items));
  await c.close();
});

Deno.test("admin: backup tools exist with a data dir and create/list/delete a zip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const t = await fixture({ dataDir: dir });
    const c = await connect(t.app, t.suToken);
    const created = structured(await c.callTool({ name: "db_backups_create", arguments: { name: "mt_1.zip" } }));
    assertEquals(created.created, "mt_1.zip");
    const list = structured(await c.callTool({ name: "db_backups_list", arguments: {} }));
    assertEquals((list.items as { key: string }[]).map((b) => b.key), ["mt_1.zip"]);
    assertFalse((await c.callTool({ name: "db_backups_delete", arguments: { key: "mt_1.zip" } })).isError);
    await c.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
