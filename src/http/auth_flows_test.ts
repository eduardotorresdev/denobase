import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { tokenClaims } from "../auth/jwt.ts";
import { defineCollection } from "../core/define.ts";
import { collectionId, registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const af_cargos = defineCollection({
  slug: "af_cargos",
  fields: [{ name: "nome", type: "text" }],
  access: { read: () => true },
});
const af_users = defineCollection({
  slug: "af_users",
  auth: { otp: { enabled: true } },
  fields: [{ name: "nome", type: "text" }, { name: "cargo", type: "relationship", relationTo: "af_cargos" }],
  access: { read: () => true },
});
const af_outros = defineCollection({ slug: "af_outros", auth: true, fields: [] });
registerCollections(af_cargos, af_users, af_outros);

const PW = "12345678";

async function setup() {
  const db = await dbWith([superusers, af_cargos, af_users, af_outros]);
  const mailer = new MemoryMailer();
  const app = createApp({ db, mailer, settings: { meta: { appName: "pbS", appURL: "https://pbs.test" } } });
  const mk = (id: string, col = af_users) =>
    app.store.collection(col).create({ id, email: `${id}@x.io`, password: PW, passwordConfirm: PW } as never);
  const call = async (path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.Authorization = token;
    const r = await app.http.request(`/api/collections/af_users${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  };
  const row = (id: string) =>
    db.prepare(`SELECT email, verified, tokenKey FROM af_users WHERE id = ?`).get(id) as {
      email: string;
      verified: number;
      tokenKey: string;
    };
  /** The {TOKEN} PB's templates put in the link. */
  const mailedToken = () => mailer.sent.at(-1)!.html.match(/\/auth\/[a-z-]+\/([\w.-]+)"/)![1];
  return { db, app, mailer, mk, call, row, mailedToken };
}

Deno.test("tokens carry PB's claims: pbc_ collectionId, type and refreshable", async () => {
  const t = await setup();
  const u = await t.mk("ana");
  const c = tokenClaims(await tokenFor(t.db, "af_users", u));
  assertEquals([c.collectionId, c.id, c.type, c.refreshable], [collectionId(af_users), "ana", "auth", true]);
});

Deno.test("auth-methods answers PB's shape", async () => {
  const t = await setup();
  const r = await t.app.http.request("/api/collections/af_users/auth-methods");
  assertEquals(await r.json(), {
    password: { identityFields: ["email"], enabled: true },
    oauth2: { providers: [], enabled: false },
    mfa: { enabled: false, duration: 0 },
    otp: { enabled: true, duration: 180 },
    authProviders: null,
    usernamePassword: false,
    emailPassword: true,
  });
  const none = await t.app.http.request("/api/collections/nope/auth-methods");
  assertEquals(none.status, 404);
});

Deno.test("verification: PB template mail, token confirms once, unknown email still 204, resend throttled", async () => {
  const t = await setup();
  await t.mk("ana");
  assertEquals((await t.call("/request-verification", { email: "nobody@x.io" })).status, 204);
  assertEquals(t.mailer.sent.length, 0);
  const bad = await t.call("/request-verification", { email: "nope" });
  assertEquals([bad.status, bad.json.data.email.code], [400, "validation_is_email"]);

  assertEquals((await t.call("/request-verification", { email: "ANA@x.io" })).status, 204);
  const m = t.mailer.sent[0];
  assertEquals([m.to, m.subject], ["ana@x.io", "Verify your pbS email"]);
  assert(m.html.includes(`href="https://pbs.test/_/#/auth/confirm-verification/`));
  await t.call("/request-verification", { email: "ana@x.io" });
  assertEquals(t.mailer.sent.length, 1);

  const token = t.mailedToken();
  assertEquals(tokenClaims(token).email, "ana@x.io");
  const wrong = await t.call("/confirm-verification", { token: "x.y.z" });
  assertEquals([wrong.status, wrong.json.data.token.code], [400, "validation_invalid_token_claims"]);
  assertEquals((await t.call("/confirm-verification", { token })).status, 204);
  assertEquals(t.row("ana").verified, 1);
});

Deno.test("superusers are verified by default", async () => {
  const t = await setup();
  const r = await t.app.http.request("/api/collections/_superusers/request-verification", { method: "POST" });
  assertEquals([r.status, (await r.json()).message], [400, "All superusers are verified by default."]);
});

Deno.test("password reset: token resets once, rotates tokenKey, verifies the email; other types refused", async () => {
  const t = await setup();
  const u = await t.mk("ana");
  const auth = await tokenFor(t.db, "af_users", u);
  // An auth token never passes as a reset token: types sign with distinct secrets.
  const asReset = await t.call("/confirm-password-reset", {
    token: auth,
    password: "novasenha1",
    passwordConfirm: "novasenha1",
  });
  assertEquals(asReset.json.data.token.code, "validation_invalid_token");

  assertEquals((await t.call("/request-password-reset", { email: "ana@x.io" })).status, 204);
  assertEquals(t.mailer.sent[0].subject, "Reset your pbS password");
  const token = t.mailedToken();
  const mismatch = await t.call("/confirm-password-reset", { token, password: "novasenha1", passwordConfirm: "x" });
  assertEquals(mismatch.json.data.passwordConfirm.code, "validation_values_mismatch");
  const before = t.row("ana").tokenKey;
  assertEquals(
    (await t.call("/confirm-password-reset", { token, password: "novasenha1", passwordConfirm: "novasenha1" })).status,
    204,
  );
  assertNotEquals(t.row("ana").tokenKey, before);
  assertEquals(t.row("ana").verified, 1);
  // The old reset token died with the old tokenKey.
  const again = await t.call("/confirm-password-reset", {
    token,
    password: "outrasenha",
    passwordConfirm: "outrasenha",
  });
  assertEquals(again.json.data.token.code, "validation_invalid_token");
  const login = await t.call("/auth-with-password", { identity: "ana@x.io", password: "novasenha1" });
  assertEquals(login.status, 200);
});

Deno.test("email change: needs auth, mails the new address, confirm needs the password", async () => {
  const t = await setup();
  const u = await t.mk("ana");
  await t.mk("bia");
  const auth = await tokenFor(t.db, "af_users", u);
  assertEquals((await t.call("/request-email-change", { newEmail: "nova@x.io" })).status, 401);
  const taken = await t.call("/request-email-change", { newEmail: "bia@x.io" }, auth);
  assertEquals(taken.json.data.newEmail.code, "validation_invalid_new_email");
  const same = await t.call("/request-email-change", { newEmail: "ana@x.io" }, auth);
  assertEquals(same.json.data.newEmail.code, "validation_not_in_invalid");

  assertEquals((await t.call("/request-email-change", { newEmail: "nova@x.io" }, auth)).status, 204);
  const m = t.mailer.sent[0];
  assertEquals([m.to, m.subject], ["nova@x.io", "Confirm your pbS new email address"]);
  const token = t.mailedToken();
  assertEquals(tokenClaims(token).newEmail, "nova@x.io");
  const badPw = await t.call("/confirm-email-change", { token, password: "errada" });
  assertEquals(badPw.json.data.password.code, "validation_invalid_password");
  assertEquals((await t.call("/confirm-email-change", { token, password: PW })).status, 204);
  assertEquals([t.row("ana").email, t.row("ana").verified], ["nova@x.io", 1]);
});

Deno.test("impersonate: superuser only, static non-refreshable token that auth-refresh hands back", async () => {
  const t = await setup();
  const u = await t.mk("ana");
  const su = await t.app.store.collection(superusers).create(
    { email: "root@x.io", password: PW, passwordConfirm: PW } as never,
  );
  const suToken = await tokenFor(t.db, "_superusers", su);
  assertEquals((await t.call("/impersonate/ana", {}, await tokenFor(t.db, "af_users", u))).status, 403);
  assertEquals((await t.call("/impersonate/zzz", {}, suToken)).status, 404);
  const r = await t.call("/impersonate/ana", { duration: 60 }, suToken);
  assertEquals([r.status, r.json.record.id], [200, "ana"]);
  const c = tokenClaims(r.json.token);
  const left = c.exp! - Date.now() / 1000;
  assertEquals([c.refreshable, left > 55 && left <= 61], [false, true]);
  const refreshed = await t.call("/auth-refresh", undefined, r.json.token);
  assertEquals(refreshed.json.token, r.json.token);
});

// PB honours ?expand/?fields on every auth response; the front logs in with expand=cargo and draws the
// sidebar from record.expand.cargo.permissoes, so a login without the expand renders an empty menu.
Deno.test("auth-with-password and auth-refresh honour ?expand and ?fields like PB", async () => {
  const t = await setup();
  const cargo = await t.app.store.collection(af_cargos).create({ nome: "PCP" } as never);
  await t.app.store.collection(af_users).create(
    { id: "ana", email: "ana@x.io", password: PW, passwordConfirm: PW, cargo: cargo.id } as never,
  );
  const login = await t.call("/auth-with-password?expand=cargo", { identity: "ana@x.io", password: PW });
  assertEquals([login.status, login.json.record.expand?.cargo?.nome], [200, "PCP"]);
  const refreshed = await t.call("/auth-refresh?expand=cargo", undefined, login.json.token);
  assertEquals(refreshed.json.record.expand?.cargo?.nome, "PCP");
  const slim = await t.call("/auth-with-password?fields=id", { identity: "ana@x.io", password: PW });
  assertEquals(slim.json.record, { id: "ana" });
});
