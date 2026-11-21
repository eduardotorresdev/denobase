import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { authorizeQuery, Browser, delivered, exchange, hidden, oauthFixture, toConsent, txnCsrf } from "./testkit.ts";
import type { App } from "../app.ts";
import { INITIALIZE, rpc } from "../mcp/testkit.ts";

/** A fresh request, its login page and a sign-in attempt on it. */
async function login(app: App, clientId: string, fields: Record<string, string>, extra: Record<string, string> = {}) {
  const b = new Browser(app);
  const html = await (await b.get(authorizeQuery(clientId, extra))).text();
  const txn = hidden(html, "txn");
  const csrf = txnCsrf(app, txn);
  const res = await b.post("/oauth/login", { txn, csrf, ...fields });
  // The page echoes the request's own ids and the typed email; nothing else may differ.
  const body = (await res.text()).replaceAll(txn, "TXN").replaceAll(csrf, "CSRF").replaceAll(fields.email, "EMAIL");
  return { b, res, body };
}

Deno.test("oauth superusers only: a superuser signs in and the grant is theirs", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf, html } = await toConsent(b, t.clientId, { email: "su@x.io" });
  assertStringIncludes(html, "su@x.io");
  assertFalse(html.includes("_superusers"));
  const u = await delivered(await b.post("/oauth/consent", { txn, csrf, action: "allow" }));
  assertEquals((await exchange(t.app, t.clientId, u.searchParams.get("code")!)).status, 200);
  const grant = t.app.db.prepare(`SELECT collection, recordId FROM _oauth_grants`).get() as Record<string, string>;
  assertEquals([grant.collection, grant.recordId], ["_superusers", t.su.id]);
});

Deno.test("oauth superusers only: an app user fails exactly like a wrong password or no account", async () => {
  const t = await oauthFixture();
  const pw = "12345678";
  const user = await login(t.app, t.clientId, { email: "ana@x.io", password: pw });
  // Asking for the users collection changes nothing: there is no auth_collection any more.
  const asked = await login(t.app, t.clientId, { email: "ana@x.io", password: pw }, { auth_collection: "mt_users" });
  const forged = await login(t.app, t.clientId, { email: "ana@x.io", password: pw, collection: "mt_users" });
  const wrong = await login(t.app, t.clientId, { email: "su@x.io", password: "wrong-one" });
  const nobody = await login(t.app, t.clientId, { email: "ghost@x.io", password: pw });
  for (const r of [user, asked, forged, wrong, nobody]) {
    assertEquals(r.res.status, 400);
    assertFalse(r.b.cookie.includes("denobase_oauth="));
    assertEquals(r.body, nobody.body);
  }
  assertStringIncludes(nobody.body, "Invalid email or password.");
});

Deno.test("oauth superusers only: no collection-bound MCP server nor resource", async () => {
  const t = await oauthFixture();
  for (const path of ["/.well-known/oauth-protected-resource/api/mcp/_superusers", "/api/mcp/_superusers"]) {
    const res = await t.app.fetch(new Request(`http://localhost${path}`));
    await res.body?.cancel();
    assertEquals(res.status, 404, path);
  }
  const challenge = await rpc(t.app, INITIALIZE, {});
  assertStringIncludes(challenge.headers.get("WWW-Authenticate")!, 'oauth-protected-resource"');
});
