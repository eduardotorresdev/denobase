import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { authorizeQuery, Browser, delivered, hidden, oauthFixture } from "./testkit.ts";
import { failureDelayMs, LIMITS } from "./ratelimit.ts";

const ana = { email: "ana@x.io" };

async function loginPage(b: Browser, clientId: string) {
  const html = await (await b.get(authorizeQuery(clientId))).text();
  return { txn: hidden(html, "txn"), csrf: hidden(html, "csrf") };
}

Deno.test("oauth login: a request opened in one browser cannot be signed in from another (login CSRF)", async () => {
  const t = await oauthFixture();
  const attacker = new Browser(t.app);
  const { txn, csrf } = await loginPage(attacker, t.clientId);
  // The victim's browser posts the attacker's request with the attacker's credentials: no binding cookie, refused.
  const victim = new Browser(t.app);
  const res = await victim.post("/oauth/login", { txn, csrf, ...ana, password: "12345678" });
  assertEquals(res.status, 403);
  assert(!victim.cookie.includes("denobase_oauth="));
  // Its own browser without the form token is refused too.
  assertEquals((await attacker.post("/oauth/login", { txn, ...ana, password: "12345678" })).status, 403);
});

Deno.test("oauth login: failures on someone's email from elsewhere do not lock them out", async () => {
  const t = await oauthFixture({}, { settings: { trustedProxy: { headers: ["x-real-ip"], useLeftmostIP: false } } });
  const attacker = new Browser(t.app);
  const ip = (n: string) => ({ "x-real-ip": n });
  // As many failures as pass without delay, all from the attacker's IP.
  for (let i = 0; i < LIMITS.accountFail[0]; i++) {
    const { txn, csrf } = await loginPage(attacker, t.clientId);
    const r = await attacker.post("/oauth/login", { txn, csrf, ...ana, password: "wrong" }, ip("10.0.0.1"));
    assertEquals(r.status, 400);
  }
  // The real user, elsewhere, still signs in (after a short delay at most).
  const user = new Browser(t.app);
  const mine = await loginPage(user, t.clientId);
  const ok = await user.post("/oauth/login", { ...mine, ...ana, password: "12345678" }, ip("192.168.1.9"));
  assertEquals(ok.status, 303);
  assertEquals(failureDelayMs(0), 0);
  assertEquals(failureDelayMs(LIMITS.accountFail[0]), 250);
  assertEquals(failureDelayMs(100), 4_000);
});

Deno.test("oauth handoff: the web app's session signs the browser in, once, only in the browser of the request", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn } = await loginPage(b, t.clientId);
  const handoff = (auth: string | null) =>
    t.app.fetch(
      new Request("http://localhost/oauth/handoff", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify({ txn }),
      }),
    );
  assertEquals((await handoff(null)).status, 401);
  // An MCP token (aud) is not a web session.
  assertEquals((await handoff(`Bearer ${t.anaToken}`)).status, 401);
  const res = await handoff(t.anaSession);
  assertEquals(res.status, 200);
  const url = new URL((await res.json()).url);
  const path = url.pathname + url.search;
  // Another browser cannot redeem it (back to the request, no session), and the code is then gone.
  const otherB = new Browser(t.app);
  assertEquals((await otherB.get(path)).status, 303);
  assert(!otherB.cookie.includes("denobase_oauth="));
  assertEquals((await b.get(path)).status, 303);
  assert(!b.cookie.includes("denobase_oauth="));
  // A fresh code in the right browser opens the consent screen as Ana, without a password.
  const fresh = new URL((await (await handoff(t.anaSession)).json()).url);
  const redeemed = await b.get(fresh.pathname + fresh.search);
  assertEquals(redeemed.status, 303);
  const consent = await (await b.get(redeemed.headers.get("location")!)).text();
  assertStringIncludes(consent, "ana@x.io");
  await delivered(await b.post("/oauth/consent", { txn, csrf: hidden(consent, "csrf"), action: "allow" }));
});

Deno.test("oauth pages: locale pt-BR renders the user's pages in Portuguese", async () => {
  const t = await oauthFixture({ locale: "pt-BR" });
  const html = await (await new Browser(t.app).get(authorizeQuery(t.clientId))).text();
  assertStringIncludes(html, '<html lang="pt-BR">');
  assertStringIncludes(html, "Entrar");
  assertFalse(html.includes("sessão"));
});

Deno.test("oauth revoke: the endpoint is rate limited per IP", async () => {
  const t = await oauthFixture();
  const revoke = () =>
    t.app.fetch(
      new Request("http://localhost/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: t.clientId, token: "nope" }).toString(),
      }),
    );
  for (let i = 0; i < LIMITS.token[0]; i++) assertEquals((await revoke()).status, 200);
  assertEquals((await revoke()).status, 429);
});
