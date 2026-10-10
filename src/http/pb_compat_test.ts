import { assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { collectionId, registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { openDb } from "../core/db.ts";
import * as migrations from "../migrations/mod.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

const pc_membros = defineCollection({
  slug: "pc_membros",
  auth: { manage: ({ user }) => user?.id === "gerente" },
  fields: [{ name: "nome", type: "text" }, { name: "nota", type: "text", hidden: true }],
  access: { read: () => true },
});
// A read rule that matches nothing (PB `@request.auth.id != ""` for a guest) and a locked one (PB nil rule).
const pc_negado = defineCollection({
  slug: "pc_negado",
  fields: [{ name: "nome", type: "text" }],
  access: { read: ({ user }) => !!user && user.id === "ninguem" },
});
const pc_cofre = defineCollection({ slug: "pc_cofre", fields: [{ name: "nome", type: "text" }] });
// Back-relation expand: pc_itens points at pc_pedidos; pc_itens_ocultos is readable only for the "visivel" ones.
const pc_pedidos = defineCollection({
  slug: "pc_pedidos",
  fields: [{ name: "nome", type: "text" }],
  access: { read: () => true },
});
const pc_itens = defineCollection({
  slug: "pc_itens",
  fields: [{ name: "titulo", type: "text" }, { name: "pedido", type: "relationship", relationTo: "pc_pedidos" }],
  access: { read: () => ({ titulo: { not_equals: "oculto" } }) },
});
registerCollections(pc_membros, pc_negado, pc_cofre, pc_pedidos, pc_itens);

async function setup() {
  const db = await dbWith([superusers, pc_membros, pc_negado, pc_cofre, pc_pedidos, pc_itens]);
  const app = createApp({ db, mailer: new MemoryMailer() });
  const mk = (id: string, emailVisibility = false) =>
    app.store.collection(pc_membros).create({
      id,
      email: `${id}@x.io`,
      emailVisibility,
      nome: id,
      nota: "segredo",
      password: "12345678",
      passwordConfirm: "12345678",
    } as never);
  const get = async (path: string, token?: string) =>
    await (await app.http.request(path, { headers: token ? { Authorization: token } : {} })).json();
  return { db, app, mk, get };
}

Deno.test("collection ids follow PB: pbc_ + crc32(type + name), and routes accept the id", async () => {
  assertEquals(collectionId(superusers), "pbc_3142635823");
  const t = await setup();
  await t.mk("ana");
  const byId = await t.get(`/api/collections/${collectionId(pc_membros)}/records`);
  assertEquals(byId.items.map((r: { id: string }) => r.id), ["ana"]);
});

Deno.test("records carry collectionId/collectionName with keys sorted like PB's export", async () => {
  const t = await setup();
  await t.mk("ana", true);
  const rec = (await t.get("/api/collections/pc_membros/records")).items[0];
  assertEquals(Object.keys(rec), [
    "collectionId",
    "collectionName",
    "created",
    "email",
    "emailVisibility",
    "id",
    "nome",
    "updated",
    "verified",
  ]);
  assertEquals([rec.collectionId, rec.collectionName], [collectionId(pc_membros), "pc_membros"]);
});

Deno.test("email shows to superusers, the owner, managers or when emailVisibility; hidden fields to superusers", async () => {
  const t = await setup();
  await t.mk("ana");
  await t.mk("bia");
  await t.mk("gerente");
  const su = await t.app.store.collection(superusers).create({
    email: "root@x.io",
    password: "12345678",
    passwordConfirm: "12345678",
  });
  const tok = (c: string, id: string) => tokenFor(t.db, c, { id } as never);
  const emailOf = async (token?: string) =>
    Object.fromEntries(
      (await t.get("/api/collections/pc_membros/records?sort=id", token)).items.map((
        r: { id: string; email?: string },
      ) => [r.id, r.email ?? null]),
    );
  assertEquals(await emailOf(), { ana: null, bia: null, gerente: null });
  assertEquals(await emailOf(await tok("pc_membros", "ana")), { ana: "ana@x.io", bia: null, gerente: null });
  assertEquals(Object.values(await emailOf(await tok("pc_membros", "gerente"))).every(Boolean), true);
  const asSu = (await t.get("/api/collections/pc_membros/records?sort=id", await tok("_superusers", su.id))).items[0];
  assertEquals([asSu.email, asSu.nota, "passwordHash" in asSu, "tokenKey" in asSu], [
    "ana@x.io",
    "segredo",
    false,
    false,
  ]);
});

Deno.test("GET /api/health answers like PB, with superuser extras", async () => {
  const t = await setup();
  assertEquals(await t.get("/api/health"), { message: "API is healthy.", code: 200, data: {} });
  const su = await t.app.store.collection(superusers).create({
    email: "root@x.io",
    password: "12345678",
    passwordConfirm: "12345678",
  });
  const body = await t.get("/api/health", await tokenFor(t.db, "_superusers", su));
  assertEquals(body.data, { canBackup: true, possibleProxyHeader: "", realIP: "" });
});

Deno.test("migrate up adds implicit auth columns an older table lacks", () => {
  const db = openDb();
  db.exec(`CREATE TABLE pc_membros (id TEXT PRIMARY KEY NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', passwordHash TEXT NOT NULL DEFAULT '', tokenKey TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0, nome TEXT, nota TEXT)`);
  db.exec(`INSERT INTO pc_membros (id, created, updated) VALUES ('old', '', '')`);
  migrations.ensureAuthColumns(db, migrations.configToSnapshot([pc_membros]));
  assertEquals(db.prepare(`SELECT emailVisibility FROM pc_membros`).get(), { emailVisibility: 0 });
});

Deno.test("skipTotal answers -1 totals like PB's search provider", async () => {
  const t = await setup();
  await t.mk("ana");
  const r = await t.get("/api/collections/pc_membros/records?skipTotal=1");
  assertEquals([r.totalItems, r.totalPages, r.items.length], [-1, -1, 1]);
});

Deno.test("PB parity over HTTP: a rejecting list rule is 200 empty, a locked one 403", async () => {
  const t = await setup();
  await t.app.store.collection(pc_negado).create({ nome: "x" } as never);
  const neg = await t.app.http.request("/api/collections/pc_negado/records");
  assertEquals([neg.status, await neg.json()], [200, {
    page: 1,
    perPage: 30,
    totalItems: 0,
    totalPages: 0,
    items: [],
  }]);
  const one = await t.app.http.request("/api/collections/pc_negado/records/qualquer");
  assertEquals([one.status, (await one.json()).message], [404, "The requested resource wasn't found."]);
  const cofre = await t.app.http.request("/api/collections/pc_cofre/records");
  assertEquals([cofre.status, await cofre.json()], [403, {
    status: 403,
    message: "Only superusers can perform this action.",
    data: {},
  }]);
});

// The Terminal de embalagem reads a pedido with expand=ambientes_via_pedido; without it the terminal found no ambiente.
Deno.test("expand <collection>_via_<field> lists the back-related records through their read access", async () => {
  const t = await setup();
  const ped = await t.app.store.collection(pc_pedidos).create({ nome: "P1" } as never);
  const outro = await t.app.store.collection(pc_pedidos).create({ nome: "P2" } as never);
  for (const [titulo, pedido] of [["cozinha", ped.id], ["oculto", ped.id], ["sala", outro.id]]) {
    await t.app.store.collection(pc_itens).create({ titulo, pedido } as never);
  }
  const titulos = (r: { expand?: { pc_itens_via_pedido?: { titulo: string }[] } }) =>
    (r.expand?.pc_itens_via_pedido ?? []).map((i) => i.titulo);
  assertEquals(titulos(await t.get(`/api/collections/pc_pedidos/records/${ped.id}?expand=pc_itens_via_pedido`)), [
    "cozinha",
  ]);
  const lista = await t.get("/api/collections/pc_pedidos/records?expand=pc_itens_via_pedido&sort=nome");
  assertEquals(lista.items.map(titulos), [["cozinha"], ["sala"]]);
  const nada = await t.get(`/api/collections/pc_pedidos/records/${ped.id}?expand=pc_itens_via_nome`);
  assertEquals(nada.expand, undefined);
});
