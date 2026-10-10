import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from "@std/assert";
import { authorizeQuery, Browser, hidden, ISSUER, oauthFixture, toConsent } from "./testkit.ts";
import { cookieName } from "./session.ts";

Deno.test("oauth session: the cookie is HttpOnly, SameSite=Lax, Path=/; Secure with __Host- on https only", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const html = await (await b.get(authorizeQuery(t.clientId))).text();
  const [txn, csrf] = [hidden(html, "txn"), hidden(html, "csrf")];
  const res = await b.post("/oauth/login", {
    txn,
    csrf,
    email: "ana@x.io",
    password: "12345678",
  });
  const sc = res.headers.get("set-cookie")!;
  assertMatch(sc, /^denobase_oauth=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assertEquals(cookieName("https://app.example"), "__Host-denobase_oauth");
});

Deno.test("oauth session: a login issues a new session id (no fixation)", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  await toConsent(b, t.clientId);
  const first = b.cookie;
  await toConsent(b, t.clientId, { email: "bia@x.io" });
  assertNotEquals(b.cookie, first);
  // The old id no longer opens a session.
  const stale = new Browser(t.app);
  stale.cookie = first;
  assertStringIncludes(await (await stale.get(authorizeQuery(t.clientId))).text(), 'action="/oauth/login"');
});

Deno.test("oauth session: consent without or with a wrong CSRF token is 403 and issues nothing", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  assertEquals((await b.post("/oauth/consent", { txn, action: "allow" })).status, 403);
  assertEquals((await b.post("/oauth/consent", { txn, csrf: csrf + "x", action: "allow" })).status, 403);
  // The request is still pending: the right token goes through.
  assertEquals((await b.post("/oauth/consent", { txn, csrf, action: "allow" })).status, 200);
});

Deno.test("oauth session: a cross-site POST (foreign Origin or Sec-Fetch-Site) is refused", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  const evil = await b.post("/oauth/consent", { txn, csrf, action: "allow" }, { origin: "https://evil.example" });
  assertEquals(evil.status, 403);
  const site = await b.post("/oauth/consent", { txn, csrf, action: "allow" }, {
    origin: ISSUER,
    "sec-fetch-site": "cross-site",
  });
  assertEquals(site.status, 403);
  const login = await b.post("/oauth/login", { txn, email: "ana@x.io", password: "12345678" }, { origin: "null" });
  assertEquals(login.status, 403);
});

Deno.test("oauth session: a real browser's form POST (Origin null under no-referrer, Sec-Fetch-Site same-origin) passes", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  const res = await b.post("/oauth/consent", { txn, csrf, action: "allow" }, {
    origin: "null",
    "sec-fetch-site": "same-origin",
  });
  assertEquals(res.status, 200);
});

Deno.test("oauth session: a consumed request cannot be replayed", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  assertEquals((await b.post("/oauth/consent", { txn, csrf, action: "allow" })).status, 200);
  const again = await b.post("/oauth/consent", { txn, csrf, action: "allow" });
  assertEquals(again.status, 400);
  assertStringIncludes(await again.text(), "expired");
});

Deno.test("oauth session: wrong password re-renders the login with one message; logout ends the session", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const html = await (await b.get(authorizeQuery(t.clientId))).text();
  const [txn, csrf0] = [hidden(html, "txn"), hidden(html, "csrf")];
  const bad = await b.post("/oauth/login", {
    txn,
    csrf: csrf0,
    email: "ana@x.io",
    password: "nope",
  });
  assertEquals(bad.status, 400);
  assertStringIncludes(await bad.text(), "Invalid email or password.");
  const { txn: t2, csrf } = await toConsent(b, t.clientId);
  const out = await b.post("/oauth/logout", { txn: t2, csrf });
  assertEquals(out.status, 303);
  assert(!b.cookie.includes("denobase_oauth="));
  assertStringIncludes(await (await b.get(out.headers.get("location")!)).text(), 'action="/oauth/login"');
});
