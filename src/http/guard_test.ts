import { assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { CODE_PERMISSION_DENIED, stableError, stableUnprocessable } from "../core/errors.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";
import { authed } from "./guard.ts";

Deno.env.set("BCRYPT_COST", "4");

const gd_users = defineCollection({
  slug: "gd_users",
  auth: true,
  fields: [{ name: "papel", type: "text" }],
  access: { read: () => true },
});
const gd_clientes = defineCollection({ slug: "gd_clientes", auth: true, fields: [], access: { read: () => true } });
registerCollections(gd_users, gd_clientes);

async function setup() {
  const db = await dbWith([superusers, gd_users, gd_clientes]);
  const app = createApp({ db, mailer: new MemoryMailer() });
  const pw = { password: "12345678", passwordConfirm: "12345678" };
  const admin = await app.store.collection(gd_users).create({ email: "a@x.io", papel: "admin", ...pw } as never);
  const op = await app.store.collection(gd_users).create({ email: "o@x.io", papel: "op", ...pw } as never);
  const cli = await app.store.collection(gd_clientes).create({ email: "c@x.io", ...pw } as never);
  const su = await app.store.collection(superusers).create({ email: "su@x.io", ...pw } as never);
  // The permission is read through req.store, as a consumer's can(p) does.
  app.http.post(
    "/api/acao",
    authed(app, {
      collections: ["gd_users"],
      allow: async ({ req, user }) =>
        req.isSuperuser || (await req.store.collection(gd_users).findOne(user!.id))?.papel === "admin",
    }, (c, { user }) => c.json({ by: user.id })),
  );
  app.http.post(
    "/api/recusa",
    authed(app, {}, () => {
      throw stableUnprocessable("pedido_fechado", "O pedido já foi fechado.");
    }),
  );
  const call = async (path: string, token?: string) => {
    const r = await app.http.request(path, { method: "POST", headers: token ? { Authorization: token } : {} });
    return { status: r.status, body: await r.json() };
  };
  const tok = (c: string, r: { id: string }) => tokenFor(db, c, r as never);
  return { call, admin, op, cli, su, tok };
}

Deno.test("authed: guest 401 with PB's message, refused 403 with data.code permissao_negada, allowed runs", async () => {
  const t = await setup();
  const guest = await t.call("/api/acao");
  assertEquals(guest.status, 401);
  assertEquals(guest.body.message, "The request requires valid record authorization token.");
  const op = await t.call("/api/acao", await t.tok("gd_users", t.op));
  assertEquals([op.status, op.body.data], [403, { code: CODE_PERMISSION_DENIED }]);
  const ok = await t.call("/api/acao", await t.tok("gd_users", t.admin));
  assertEquals([ok.status, ok.body], [200, { by: t.admin.id }]);
});

Deno.test("authed: another auth collection is refused; a superuser passes both checks", async () => {
  const t = await setup();
  const cli = await t.call("/api/acao", await t.tok("gd_clientes", t.cli));
  assertEquals([cli.status, cli.body.data.code], [403, CODE_PERMISSION_DENIED]);
  const su = await t.call("/api/acao", await t.tok("_superusers", t.su));
  assertEquals([su.status, su.body.by], [200, t.su.id]);
});

Deno.test("a stable error thrown by a route reaches the client as PB JSON with data.code", async () => {
  const t = await setup();
  const r = await t.call("/api/recusa", await t.tok("gd_users", t.op));
  assertEquals(r, {
    status: 422,
    body: { status: 422, message: "O pedido já foi fechado.", data: { code: "pedido_fechado" } },
  });
});

Deno.test("stableError refuses a code that is not snake_case", () => {
  assertThrows(() => stableError(400, "PedidoFechado", "x"));
  assertThrows(() => stableError(400, "pedido-fechado", "x"));
  assertEquals(stableError(400, "pedido_fechado_2", "x").code, "pedido_fechado_2");
});
