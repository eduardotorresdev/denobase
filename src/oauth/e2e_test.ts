import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from "@std/assert";
import { connect, INITIALIZE, mt_users, rpc } from "../mcp/testkit.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { tokenFor } from "../testing/mod.ts";
import {
  admin,
  authorizeQuery,
  Browser,
  delivered,
  exchange,
  hidden,
  ISSUER,
  oauthFixture,
  REDIRECT,
  register,
  RESOURCE,
  toConsent,
  token,
  tokens,
} from "./testkit.ts";

Deno.test("oauth e2e: discovery, DCR, login, consent, code + PKCE, MCP call, refresh rotation, admin revoke", async () => {
  const t = await oauthFixture();
  const app = t.app;

  // 1. The MCP says where to authenticate; the resource names this server as its authorization server.
  const unauth = await rpc(app, INITIALIZE);
  assertEquals(unauth.status, 401);
  assertMatch(unauth.headers.get("WWW-Authenticate")!, /resource_metadata="http:\/\/localhost:8090\/\.well-known/);
  const prm = await (await app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource/api/mcp")))
    .json();
  assertEquals([prm.resource, prm.authorization_servers], [RESOURCE, [ISSUER]]);
  const asm = await (await app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))).json();
  assertEquals(asm.issuer, ISSUER);
  assertEquals(asm.code_challenge_methods_supported, ["S256"]);
  assertEquals(asm.registration_endpoint, `${ISSUER}/oauth/register`);
  assertEquals(asm.authorization_response_iss_parameter_supported, true);

  // 2. A public client registered by DCR (the fixture's); 3. authorize without a session shows the login page.
  const b = new Browser(app);
  const login = await b.get(authorizeQuery(t.clientId, { redirect_uri: "http://127.0.0.1:51000/callback" }));
  assertEquals(login.status, 200);
  const loginHtml = await login.text();
  assertStringIncludes(loginHtml, "Test client");
  assertStringIncludes(loginHtml, 'action="/oauth/login"');
  const txn = hidden(loginHtml, "txn");
  const signedIn = await b.post("/oauth/login", {
    txn,
    csrf: hidden(loginHtml, "csrf"),
    collection: "mt_users",
    email: "ana@x.io",
    password: "12345678",
  });
  assertEquals(signedIn.status, 303);
  assertMatch(b.cookie, /(^|; )denobase_oauth=/);
  const consent = await (await b.get(signedIn.headers.get("location")!)).text();
  assertStringIncludes(consent, "127.0.0.1:51000");
  assertStringIncludes(consent, "ana@x.io");
  assertStringIncludes(consent, RESOURCE.replace("http://", ""));
  // Loopback: any port, same path (RFC 8252); the answer carries state and iss (RFC 9207), delivered by the final page.
  const back = await b.post("/oauth/consent", { txn, csrf: hidden(consent, "csrf"), action: "allow" });
  const cb = await delivered(back, "http://127.0.0.1:51000/callback");
  assertEquals([cb.searchParams.get("state"), cb.searchParams.get("iss")], ["st-1", ISSUER]);

  // 4. Code + verifier for tokens; the access token opens /api/mcp.
  const got = await exchange(app, t.clientId, cb.searchParams.get("code")!, {
    redirect_uri: "http://127.0.0.1:51000/callback",
  });
  assertEquals(got.status, 200, JSON.stringify(got.body));
  assertEquals(got.headers.get("cache-control"), "no-store");
  assertEquals([got.body.token_type, got.body.scope, got.body.expires_in], ["Bearer", "mcp", 3600]);
  const c = await connect(app, got.body.access_token);
  const names = (await c.listTools()).tools.map((x) => x.name);
  assert(names.includes("db_list") && names.includes("db_create"));
  await c.close();

  // 5. Refresh rotates: a new pair, and the old refresh token is spent.
  const r1 = await token(app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: got.body.refresh_token,
  });
  assertEquals(r1.status, 200);
  assertNotEquals(r1.body.refresh_token, got.body.refresh_token);
  assertEquals((await rpc(app, INITIALIZE, { Authorization: `Bearer ${r1.body.access_token}` })).status, 200);

  // The admin sees the grant and revokes it: the next /api/mcp call is 401 and the refresh is dead.
  const grants = await (await admin(app, t.suSession, "GET", "/api/oauth/grants")).json();
  assertEquals(grants.items.map((g: { email: string; clientName: string }) => [g.email, g.clientName]), [
    ["ana@x.io", "Test client"],
  ]);
  assertEquals((await admin(app, t.suSession, "DELETE", `/api/oauth/grants/${grants.items[0].id}`)).status, 204);
  const after = await rpc(app, INITIALIZE, { Authorization: `Bearer ${r1.body.access_token}` });
  assertEquals(after.status, 401);
  assertMatch(after.headers.get("WWW-Authenticate")!, /error="invalid_token"/);
  const dead = await token(app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: r1.body.refresh_token,
  });
  assertEquals([dead.status, dead.body.error], [400, "invalid_grant"]);
});

Deno.test("oauth e2e: a second authorization skips the remembered consent; prompt=consent asks again", async () => {
  const app = "https://app.example/cb";
  const t = await oauthFixture({
    clients: [{ id: "office", name: "Office", redirectUris: [app], secret: "s3cret" }],
  });
  const b = new Browser(t.app);
  const q = (extra: Record<string, string> = {}) => authorizeQuery("office", { redirect_uri: app, ...extra });
  const login = await (await b.get(q())).text();
  const txn = hidden(login, "txn");
  await b.post("/oauth/login", {
    txn,
    csrf: hidden(login, "csrf"),
    collection: "mt_users",
    email: "ana@x.io",
    password: "12345678",
  });
  const consent = await (await b.get(`/oauth/authorize?txn=${txn}`)).text();
  const first = await b.post("/oauth/consent", { txn, csrf: hidden(consent, "csrf"), action: "allow" });
  assertEquals(first.status, 200);
  // Same browser session, same static client, resource and scope: straight back with a code.
  const again = await b.get(q({ state: "st-2" }));
  assertEquals(again.status, 303);
  const u = new URL(again.headers.get("location")!);
  assert(u.searchParams.get("code"));
  assertEquals(u.searchParams.get("state"), "st-2");
  const asked = await b.get(q({ prompt: "consent" }));
  assertEquals(asked.status, 200);
  assertStringIncludes(await asked.text(), 'value="allow"');
});

Deno.test("oauth e2e: a public DCR client on a loopback redirect always shows the consent screen", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  await delivered(await b.post("/oauth/consent", { txn, csrf, action: "allow" }));
  // Another process on another loopback port could have started this one: no silent code.
  const again = await b.get(authorizeQuery(t.clientId, { redirect_uri: "http://127.0.0.1:40000/callback" }));
  assertEquals(again.status, 200);
  assertStringIncludes(await again.text(), 'value="allow"');
});

Deno.test("oauth e2e: Deny answers access_denied with state and iss", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  const u = await delivered(await b.post("/oauth/consent", { txn, csrf, action: "deny" }));
  assertEquals([u.searchParams.get("error"), u.searchParams.get("state"), u.searchParams.get("iss")], [
    "access_denied",
    "st-1",
    ISSUER,
  ]);
  assertEquals(u.searchParams.get("code"), null);
});

Deno.test("oauth e2e: OTP login on a collection with OTP enabled", async () => {
  const mailer = new MemoryMailer();
  const t = await oauthFixture({ collections: ["mt_users"] }, { mailer });
  // mt_users has no OTP config in the shared fixture: turn it on for this test only.
  const users = mt_users as { auth: unknown };
  const prev = users.auth;
  users.auth = { otp: { enabled: true } };
  try {
    const b = new Browser(t.app);
    const page = await (await b.get(authorizeQuery(t.clientId))).text();
    assertStringIncludes(page, 'action="/oauth/otp/request"');
    const [txn, csrf] = [hidden(page, "txn"), hidden(page, "csrf")];
    const sent = await (await b.post("/oauth/otp/request", { txn, csrf, email: "ana@x.io" }))
      .text();
    const otpId = hidden(sent, "otpId");
    const mail = mailer.sent.at(-1)!;
    const code = (mail.text ?? mail.html ?? "").match(/\b(\d{8})\b/)![1];
    const res = await b.post("/oauth/otp/verify", { txn, csrf, otpId, code });
    assertEquals(res.status, 303);
    assertStringIncludes(await (await b.get(res.headers.get("location")!)).text(), 'value="allow"');
  } finally {
    users.auth = prev;
  }
});

Deno.test("oauth e2e: a superuser authorizes when the request names auth_collection=_superusers", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t, { email: "su@x.io", collection: "_superusers" });
  const c = await connect(t.app, tk.access_token);
  assert((await c.listTools()).tools.some((x) => x.name === "db_sql"));
  await c.close();
});

Deno.test("oauth e2e: CIMD client (https client_id) resolved through a mocked fetch", async () => {
  const id = "https://client.example.com/oauth/metadata.json";
  let fetched = 0;
  const t = await oauthFixture({
    cimd: {
      resolve: () => Promise.resolve(["93.184.216.34"]),
      fetch: (input) => {
        fetched++;
        assertEquals(String(input), id);
        return Promise.resolve(
          new Response(JSON.stringify({ client_id: id, client_name: "Doc client", redirect_uris: [REDIRECT] }), {
            headers: { "content-type": "application/json", "cache-control": "max-age=600" },
          }),
        );
      },
    },
  });
  const b = new Browser(t.app);
  const { txn, csrf, html } = await toConsent(b, id);
  assertStringIncludes(html, "Doc client");
  assertStringIncludes(html, "client.example.com");
  const code = (await delivered(await b.post("/oauth/consent", { txn, csrf, action: "allow" }))).searchParams.get(
    "code",
  )!;
  const r = await exchange(t.app, id, code);
  assertEquals(r.status, 200);
  // Cached for max-age: the token request did not fetch again.
  assertEquals(fetched, 1);
});

Deno.test("oauth e2e: the SPA's session token is refused on /api/mcp and the OAuth token is a guest on REST", async () => {
  const t = await oauthFixture();
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: t.anaSession })).status, 401);
  const tk = await tokens(t);
  const list = await t.app.fetch(
    new Request("http://localhost/api/collections/mt_notas/records", {
      headers: { Authorization: `Bearer ${tk.access_token}` },
    }),
  );
  assertEquals((await list.json()).items.length, 0);
  // While Ana's own session sees her note.
  const own = await t.app.fetch(
    new Request("http://localhost/api/collections/mt_notas/records", {
      headers: { Authorization: await tokenFor(t.app.db, "mt_users", t.ana) },
    }),
  );
  assertEquals((await own.json()).items.length, 1);
});

Deno.test("oauth e2e: DCR rejects bad redirect URIs and hands a secret only to confidential clients", async () => {
  const t = await oauthFixture();
  const bad = await register(t.app, { redirect_uris: ["http://evil.example/cb"] });
  assertEquals([bad.status, (await bad.json()).error], [400, "invalid_redirect_uri"]);
  const conf = await (await register(t.app, { redirect_uris: ["https://app.example/cb"] })).json();
  assert(conf.client_secret);
  assertEquals(conf.token_endpoint_auth_method, "client_secret_basic");
  const pub = await (await register(t.app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })).json();
  assertEquals(pub.client_secret, undefined);
});
