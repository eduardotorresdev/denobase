import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  authorizeQuery,
  Browser,
  callback,
  delivered,
  exchange,
  hidden,
  oauthFixture,
  REDIRECT,
  RESOURCE,
  toConsent,
  txnCsrf,
} from "./testkit.ts";
import type { App } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { INITIALIZE, mt_users, rpc } from "../mcp/testkit.ts";

/** A fresh request (auth_collection when given) and its login page. */
async function open(b: Browser, clientId: string, extra: Record<string, string> = {}) {
  const res = await b.get(authorizeQuery(clientId, extra));
  assertEquals(res.status, 200);
  const html = await res.text();
  const txn = hidden(html, "txn");
  return { txn, csrf: txnCsrf(b.app, txn), html };
}

async function login(app: App, clientId: string, extra: Record<string, string>, fields: Record<string, string>) {
  const b = new Browser(app);
  const { txn, csrf } = await open(b, clientId, extra);
  const res = await b.post("/oauth/login", { txn, csrf, ...fields });
  // The page echoes the request's own ids and the typed email; nothing else may differ.
  const body = (await res.text()).replaceAll(txn, "TXN").replaceAll(csrf, "CSRF").replaceAll(fields.email, "EMAIL");
  return { b, res, body };
}

Deno.test("oauth collection: the login page is the same for every collection, with no selector nor name", async () => {
  const t = await oauthFixture();
  const pages = await Promise.all(
    ([{}, { auth_collection: "mt_users" }, { auth_collection: "_superusers" }] as Record<string, string>[]).map(
      async (extra) => {
        const { html, txn, csrf } = await open(new Browser(t.app), t.clientId, extra);
        return html.replaceAll(txn, "TXN").replaceAll(csrf, "CSRF");
      },
    ),
  );
  assertEquals(pages[1], pages[0]);
  assertEquals(pages[2], pages[0]);
  for (const s of ["<select", 'name="collection"', "_superusers", "mt_users", "Administrator"]) {
    assertFalse(pages[0].includes(s), s);
  }
});

Deno.test("oauth collection: auth_collection=_superusers signs a superuser in, and the token is theirs", async () => {
  const t = await oauthFixture();
  const { b, res } = await login(t.app, t.clientId, { auth_collection: "_superusers" }, {
    email: "su@x.io",
    password: "12345678",
  });
  assertEquals(res.status, 303);
  const consent = await (await b.get(res.headers.get("location")!)).text();
  assertStringIncludes(consent, "su@x.io");
  assertFalse(consent.includes("_superusers"));
  const txn = hidden(consent, "txn");
  const u = await delivered(await b.post("/oauth/consent", { txn, csrf: hidden(consent, "csrf"), action: "allow" }));
  const tk = await exchange(t.app, t.clientId, u.searchParams.get("code")!);
  assertEquals(tk.status, 200);
  const grant = t.app.db.prepare(`SELECT collection, recordId FROM _oauth_grants`).get() as Record<string, string>;
  assertEquals([grant.collection, grant.recordId], ["_superusers", t.su.id]);
});

Deno.test("oauth collection: an account of another collection fails exactly like a wrong password or no account", async () => {
  const t = await oauthFixture();
  const pw = "12345678";
  // A superuser's email and password on a users request (named, and by default).
  const suAsUser = await login(t.app, t.clientId, { auth_collection: "mt_users" }, { email: "su@x.io", password: pw });
  const suByDefault = await login(t.app, t.clientId, {}, { email: "su@x.io", password: pw });
  // A user's on a superusers request.
  const userAsSu = await login(t.app, t.clientId, { auth_collection: "_superusers" }, {
    email: "ana@x.io",
    password: pw,
  });
  const wrongPassword = await login(t.app, t.clientId, {}, { email: "ana@x.io", password: "wrong-one" });
  const nobody = await login(t.app, t.clientId, {}, { email: "ghost@x.io", password: pw });
  for (const r of [suAsUser, suByDefault, userAsSu, wrongPassword, nobody]) {
    assertEquals(r.res.status, 400);
    assertFalse(r.b.cookie.includes("denobase_oauth="));
    assertEquals(r.body, nobody.body);
  }
  assertStringIncludes(nobody.body, "Invalid email or password.");
});

Deno.test("oauth collection: a collection that may not authorize is invalid_request", async () => {
  const t = await oauthFixture({ collections: ["mt_users"] });
  for (const asked of ["_superusers", "mt_notas", "nope"]) {
    const u = callback(await new Browser(t.app).get(authorizeQuery(t.clientId, { auth_collection: asked })));
    assertEquals(u.searchParams.get("error"), "invalid_request");
    assertEquals(u.searchParams.get("state"), "st-1");
  }
  // Narrowed by settings too.
  const s = await oauthFixture({}, { settings: { oauth: { allowedCollections: ["mt_users"] } } });
  const u = callback(await new Browser(s.app).get(authorizeQuery(s.clientId, { auth_collection: "_superusers" })));
  assertEquals(u.searchParams.get("error"), "invalid_request");
});

Deno.test("oauth collection: a collection field forged in the POST is ignored", async () => {
  const t = await oauthFixture();
  // A users request: the superuser cannot get in by posting collection=_superusers.
  const forged = await login(t.app, t.clientId, {}, {
    email: "su@x.io",
    password: "12345678",
    collection: "_superusers",
  });
  assertEquals(forged.res.status, 400);
  // And a user still signs in to a users request whatever the field says.
  const ana = await login(t.app, t.clientId, {}, {
    email: "ana@x.io",
    password: "12345678",
    collection: "_superusers",
  });
  assertEquals(ana.res.status, 303);
  const s = t.app.db.prepare(`SELECT collection, recordId FROM _oauth_sessions`).get() as Record<string, string>;
  assertEquals([s.collection, s.recordId], ["mt_users", t.ana.id]);
});

Deno.test("oauth collection: a session of another collection means signing in again", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  await toConsent(b, t.clientId, { email: "ana@x.io" });
  // Same collection: straight to consent.
  assertStringIncludes(await (await b.get(authorizeQuery(t.clientId))).text(), 'value="allow"');
  // Another collection: the plain login page, as if signed out.
  const other = await (await b.get(authorizeQuery(t.clientId, { auth_collection: "_superusers" }))).text();
  assertStringIncludes(other, 'action="/oauth/login"');
  assertFalse(other.includes("ana@x.io"));
  // prompt=none cannot pass silently either.
  const none = callback(await b.get(authorizeQuery(t.clientId, { auth_collection: "_superusers", prompt: "none" })));
  assertEquals(none.searchParams.get("error"), "login_required");
});

Deno.test("oauth collection: codes by email answer the same whether the account is in the collection or not", async () => {
  const mailer = new MemoryMailer();
  // One IP per ask: codes are limited to a few a minute per IP.
  const t = await oauthFixture({}, {
    mailer,
    settings: { trustedProxy: { headers: ["x-real-ip"], useLeftmostIP: false } },
  });
  let n = 0;
  const users = mt_users as { auth: unknown };
  const prev = users.auth;
  users.auth = { otp: { enabled: true } };
  try {
    const ask = async (extra: Record<string, string>, email: string) => {
      const b = new Browser(t.app);
      const { txn, csrf } = await open(b, t.clientId, extra);
      const ip = { "x-real-ip": `10.0.0.${++n}` };
      const res = await b.post("/oauth/otp/request", { txn, csrf, email }, ip);
      const html = await res.text();
      const otpId = hidden(html, "otpId");
      const verify = await b.post("/oauth/otp/verify", { txn, csrf, otpId, code: "00000000" }, ip);
      const clean = (s: string) => s.replaceAll(txn, "TXN").replaceAll(csrf, "CSRF").replaceAll(otpId, "ID");
      return { status: res.status, page: clean(html), verify: [verify.status, clean(await verify.text())] };
    };
    const before = mailer.sent.length;
    const real = await ask({}, "ana@x.io");
    assertEquals(mailer.sent.length, before + 1);
    const ghost = await ask({}, "ghost@x.io");
    // The superuser on a users request, and a user on a superusers request (no codes there): no mail, same pages.
    const su = await ask({}, "su@x.io");
    const anaAsSu = await ask({ auth_collection: "_superusers" }, "ana@x.io");
    assertEquals(mailer.sent.length, before + 1);
    for (const r of [ghost, su, anaAsSu]) {
      assertEquals(r.status, real.status);
      assertEquals(r.page.replace(/(ghost|su|ana)@x\.io/g, "E"), real.page.replace(/ana@x\.io/g, "E"));
      assertEquals(r.verify, real.verify);
    }
  } finally {
    users.auth = prev;
  }
});

Deno.test("oauth collection: a static client fixes its collection; another auth_collection is invalid_request", async () => {
  const t = await oauthFixture({
    clients: [{ id: "admin-cli", name: "Admin", redirectUris: [REDIRECT], authCollection: "_superusers" }],
  });
  const bad = callback(await new Browser(t.app).get(authorizeQuery("admin-cli", { auth_collection: "mt_users" })));
  assertEquals(bad.searchParams.get("error"), "invalid_request");
  const b = new Browser(t.app);
  const { txn, csrf } = await open(b, "admin-cli");
  const res = await b.post("/oauth/login", { txn, csrf, email: "su@x.io", password: "12345678" });
  assertEquals(res.status, 303);
  assert(b.cookie.includes("denobase_oauth="));
});

Deno.test("oauth collection: /api/mcp/_superusers signs a superuser in with no auth_collection, and only there", async () => {
  const t = await oauthFixture();
  const bound = `${RESOURCE}/_superusers`;
  const meta = await t.app.fetch(
    new Request("http://localhost/.well-known/oauth-protected-resource/api/mcp/_superusers"),
  );
  assertEquals((await meta.json()).resource, bound);
  const unknown = await t.app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource/api/mcp/nope"));
  assertEquals(unknown.status, 404);
  const challenge = await rpc(t.app, INITIALIZE, {}, "POST", "/api/mcp/_superusers");
  assertStringIncludes(challenge.headers.get("WWW-Authenticate")!, "oauth-protected-resource/api/mcp/_superusers");

  const { b, res } = await login(t.app, t.clientId, { resource: bound }, { email: "su@x.io", password: "12345678" });
  assertEquals(res.status, 303);
  const consent = await (await b.get(res.headers.get("location")!)).text();
  const u = await delivered(
    await b.post("/oauth/consent", { txn: hidden(consent, "txn"), csrf: hidden(consent, "csrf"), action: "allow" }),
  );
  const tk = await exchange(t.app, t.clientId, u.searchParams.get("code")!, { resource: bound });
  assertEquals(tk.status, 200, JSON.stringify(tk.body));
  const auth = { Authorization: `Bearer ${tk.body.access_token}` };
  assertEquals((await rpc(t.app, INITIALIZE, auth, "POST", "/api/mcp/_superusers")).status, 200);
  assertEquals((await rpc(t.app, INITIALIZE, auth)).status, 401);

  // The bound resource's collection is the only one: a user's account cannot sign in there, nor ask for another.
  const user = await login(t.app, t.clientId, { resource: bound }, { email: "ana@x.io", password: "12345678" });
  assertEquals(user.res.status, 400);
  const other = await new Browser(t.app).get(
    authorizeQuery(t.clientId, { resource: bound, auth_collection: "mt_users" }),
  );
  assertEquals(other.status, 303);
  assertEquals(new URL(other.headers.get("location")!).searchParams.get("error"), "invalid_request");
});
