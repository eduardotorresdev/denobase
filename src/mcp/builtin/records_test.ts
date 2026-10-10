import { assert, assertEquals, assertFalse } from "@std/assert";
import { connect, fixture, structured } from "../testkit.ts";

Deno.test("records: filter, sort, expand and fields go through the PB compiler", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.suToken);
  const r = structured(
    await c.callTool({
      name: "db_list",
      arguments: {
        collection: "mt_notas",
        filter: "titulo ~ 'da'",
        sort: "-titulo",
        expand: "dono",
        fields: "titulo,expand.dono.nome",
      },
    }),
  );
  assertEquals(r.items, [
    { titulo: "da bia", expand: { dono: { nome: "Bia" } } },
    { titulo: "da ana", expand: { dono: { nome: "Ana" } } },
  ]);
  const bad = await c.callTool({ name: "db_list", arguments: { collection: "mt_notas", filter: "nope ===" } });
  assert(bad.isError);
  assertEquals(structured(bad).status, 400);
  await c.close();
});

Deno.test("records: create, get and delete as the owner", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const created = structured(
    await c.callTool({
      name: "db_create",
      arguments: { collection: "mt_notas", data: { titulo: "nova", dono: t.ana.id } },
    }),
  );
  const got = structured(await c.callTool({ name: "db_get", arguments: { collection: "mt_notas", id: created.id } }));
  assertEquals(got.titulo, "nova");
  const del = await c.callTool({ name: "db_delete", arguments: { collection: "mt_notas", id: created.id } });
  assertFalse(del.isError);
  assertEquals(await t.app.store.collection("mt_notas").findOne(String(created.id)), undefined);
  await c.close();
});

Deno.test("records: batch is all or nothing and needs batch enabled", async () => {
  const off = await fixture();
  const c0 = await connect(off.app, off.anaToken);
  const r0 = await c0.callTool({
    name: "db_batch",
    arguments: { requests: [{ action: "create", collection: "mt_notas", data: { titulo: "x" } }] },
  });
  assertEquals(structured(r0).code, "permissao_negada");
  await c0.close();

  const t = await fixture({ settings: { batch: { enabled: true, maxRequests: 10 } } });
  const c = await connect(t.app, t.anaToken);
  const before = await t.app.store.collection("mt_notas").count();
  const fail = await c.callTool({
    name: "db_batch",
    arguments: {
      requests: [
        { action: "create", collection: "mt_notas", data: { titulo: "ok", dono: t.ana.id } },
        { action: "create", collection: "mt_notas", data: {} },
      ],
    },
  });
  assert(fail.isError);
  assert("1" in ((structured(fail).data as { requests: Record<string, unknown> }).requests));
  assertEquals(await t.app.store.collection("mt_notas").count(), before);
  const ok = await c.callTool({
    name: "db_batch",
    arguments: {
      requests: [
        { action: "create", collection: "mt_notas", data: { titulo: "um", dono: t.ana.id } },
        { action: "update", collection: "mt_notas", id: t.notaAna.id, data: { titulo: "dois" } },
      ],
    },
  });
  assertFalse(ok.isError);
  assertEquals((structured(ok).results as unknown[]).length, 2);
  assertEquals(await t.app.store.collection("mt_notas").count(), before + 1);
  await c.close();
});

Deno.test("records: batch upsert checks existence as the caller, so an unreadable id answers like a create", async () => {
  const t = await fixture({ settings: { batch: { enabled: true, maxRequests: 10 } } as never });
  const c = await connect(t.app, t.anaToken);
  const upsert = (id: string) =>
    c.callTool({
      name: "db_batch",
      arguments: {
        requests: [{ action: "upsert", collection: "mt_notas", id, data: { titulo: "x", dono: t.ana.id } }],
      },
    });
  const alheia = structured(await upsert(t.notaBia.id));
  const sumida = structured(await upsert("naoexiste12345"));
  // Bia's note is never updated, and the answer is the create's (not the update rule's 404).
  assertEquals((await t.app.store.collection("mt_notas").findOne(t.notaBia.id))?.titulo, "da bia");
  assert(alheia.status !== 404);
  assertFalse(sumida.status === 404);
  await c.close();
});
