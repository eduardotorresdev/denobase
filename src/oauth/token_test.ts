import { assertEquals, assertMatch } from "@std/assert";
import { INITIALIZE, rpc } from "../mcp/testkit.ts";
import { canonicalResource } from "./flow.ts";
import {
  admin,
  authorizeCode,
  Browser,
  exchange,
  oauthFixture,
  REDIRECT,
  register,
  token,
  tokens,
  VERIFIER,
} from "./testkit.ts";

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

Deno.test("oauth token: a leaked code sent with another client or verifier neither burns it nor revokes", async () => {
  const t = await oauthFixture();
  const other = (await (await register(t.app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }))
    .json()).client_id;
  const code = await authorizeCode(new Browser(t.app), t.clientId);
  const bad = await exchange(t.app, t.clientId, code, { code_verifier: "x".repeat(43) });
  assertEquals([bad.status, bad.body.error], [400, "invalid_grant"]);
  assertEquals((await exchange(t.app, other, code)).body.error, "invalid_grant");
  // The legitimate client still gets its tokens.
  assertEquals((await exchange(t.app, t.clientId, code)).status, 200);
});

Deno.test("oauth token: redirect_uri, resource or client_id other than the authorization's are refused", async () => {
  const t = await oauthFixture();
  const other = (await (await register(t.app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }))
    .json()).client_id;
  for (
    const [extra, error] of [
      [{ redirect_uri: "http://127.0.0.1:33418/other" }, "invalid_grant"],
      [{ resource: "https://elsewhere.example/api/mcp" }, "invalid_target"],
      [{ client_id: other }, "invalid_grant"],
    ] as const
  ) {
    const code = await authorizeCode(new Browser(t.app), t.clientId);
    const r = await exchange(t.app, t.clientId, code, extra);
    assertEquals(r.body.error, error, JSON.stringify(extra));
  }
});

Deno.test("oauth token: a reused code is refused and revokes what the first exchange issued", async () => {
  const t = await oauthFixture();
  const code = await authorizeCode(new Browser(t.app), t.clientId);
  const first = await exchange(t.app, t.clientId, code);
  assertEquals(first.status, 200);
  assertEquals((await rpc(t.app, INITIALIZE, bearer(first.body.access_token))).status, 200);
  assertEquals((await exchange(t.app, t.clientId, code)).body.error, "invalid_grant");
  assertEquals((await rpc(t.app, INITIALIZE, bearer(first.body.access_token))).status, 401);
  const refresh = await token(t.app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: first.body.refresh_token,
  });
  assertEquals(refresh.body.error, "invalid_grant");
});

Deno.test("oauth token: an expired code is invalid_grant", async () => {
  const t = await oauthFixture();
  const code = await authorizeCode(new Browser(t.app), t.clientId);
  t.app.db.prepare(`UPDATE _oauth_codes SET expires = 0`).run();
  assertEquals((await exchange(t.app, t.clientId, code)).body.error, "invalid_grant");
});

Deno.test("oauth token: reusing a rotated refresh token revokes the whole family", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  const refresh = (rt: string) =>
    token(t.app, { grant_type: "refresh_token", client_id: t.clientId, refresh_token: rt });
  const second = await refresh(tk.refresh_token);
  assertEquals(second.status, 200);
  assertEquals((await refresh(tk.refresh_token)).body.error, "invalid_grant");
  // The legitimate holder of the new one is cut off too: the family is gone.
  assertEquals((await refresh(second.body.refresh_token)).body.error, "invalid_grant");
  // And so is the access token already issued from the rotated one: the whole grant is revoked (RFC 9700 §4.14.2).
  assertEquals((await rpc(t.app, INITIALIZE, bearer(second.body.access_token))).status, 401);
});

Deno.test("oauth token: a refresh may narrow the scope, never widen it", async () => {
  const t = await oauthFixture();
  const code = await authorizeCode(new Browser(t.app), t.clientId, undefined, { scope: "mcp:read offline_access" });
  const tk = (await exchange(t.app, t.clientId, code)).body;
  assertEquals(tk.scope, "mcp:read offline_access");
  const wide = await token(t.app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: tk.refresh_token,
    scope: "mcp",
  });
  assertEquals(wide.body.error, "invalid_scope");
  const narrow = await token(t.app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: tk.refresh_token,
    scope: "mcp:read",
  });
  assertEquals(narrow.body.scope, "mcp:read");
  // Narrowing is for that access token only: the next refresh gets the family's scope back (RFC 6749 §6).
  const next = await token(t.app, {
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: narrow.body.refresh_token,
  });
  assertEquals(next.body.scope, "mcp:read offline_access");
});

Deno.test("oauth token: redirect_uri may be left out only when the authorization left it out", async () => {
  const t = await oauthFixture();
  const sent = await authorizeCode(new Browser(t.app), t.clientId);
  assertEquals((await exchange(t.app, t.clientId, sent, { redirect_uri: "" })).body.error, "invalid_grant");
  const b = new Browser(t.app);
  const omitted = await authorizeCode(b, t.clientId, undefined, { redirect_uri: "" });
  const r = await token(t.app, {
    grant_type: "authorization_code",
    client_id: t.clientId,
    code: omitted,
    code_verifier: VERIFIER,
  });
  assertEquals(r.status, 200, JSON.stringify(r.body));
});

Deno.test("oauth token: the resource compares in canonical form (trailing slash, host case, default port)", async () => {
  const t = await oauthFixture();
  const spelled = "HTTP://LOCALHOST:8090/api/mcp/";
  const code = await authorizeCode(new Browser(t.app), t.clientId, undefined, { resource: spelled });
  const r = await exchange(t.app, t.clientId, code, { resource: "http://localhost:8090/api/mcp" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  assertEquals(canonicalResource("https://host:443/api/mcp/"), "https://host/api/mcp");
});

Deno.test("oauth token: a changed tokenKey (password change) makes the refresh invalid_grant", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  t.app.db.prepare(`UPDATE mt_users SET tokenKey = 'rotated' WHERE id = ?`).run(t.ana.id);
  const r = await token(t.app, { grant_type: "refresh_token", client_id: t.clientId, refresh_token: tk.refresh_token });
  assertEquals(r.body.error, "invalid_grant");
  // And the access token, signed with the old key, no longer verifies.
  assertEquals((await rpc(t.app, INITIALIZE, bearer(tk.access_token))).status, 401);
});

Deno.test("oauth token: a confidential client must authenticate (basic or post)", async () => {
  const t = await oauthFixture();
  const reg = await (await register(t.app, { redirect_uris: [REDIRECT] })).json();
  const code = await authorizeCode(new Browser(t.app), reg.client_id);
  const none = await exchange(t.app, reg.client_id, code);
  assertEquals([none.status, none.body.error], [401, "invalid_client"]);
  const code2 = await authorizeCode(new Browser(t.app), reg.client_id);
  const ok = await token(t.app, {
    grant_type: "authorization_code",
    code: code2,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  }, { Authorization: `Basic ${btoa(`${reg.client_id}:${reg.client_secret}`)}` });
  assertEquals(ok.status, 200, JSON.stringify(ok.body));
});

Deno.test("oauth token: a removed client loses its tokens at once", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  assertEquals((await admin(t.app, t.suSession, "DELETE", `/api/oauth/clients/${t.clientId}`)).status, 204);
  const res = await rpc(t.app, INITIALIZE, bearer(tk.access_token));
  assertEquals(res.status, 401);
  assertMatch(res.headers.get("WWW-Authenticate")!, /invalid_token/);
  const r = await token(t.app, { grant_type: "refresh_token", client_id: t.clientId, refresh_token: tk.refresh_token });
  assertEquals(r.body.error, "invalid_client");
});

Deno.test("oauth token: a token for another resource (wrong aud) is refused by /api/mcp", async () => {
  const other = "https://other.example/api/mcp";
  const t = await oauthFixture({ extraResources: [other] });
  const code = await authorizeCode(new Browser(t.app), t.clientId, undefined, { resource: other });
  const tk = await exchange(t.app, t.clientId, code, { resource: other });
  assertEquals(tk.status, 200);
  const res = await rpc(t.app, INITIALIZE, bearer(tk.body.access_token));
  assertEquals(res.status, 401);
  assertMatch(res.headers.get("WWW-Authenticate")!, /invalid_token/);
});

Deno.test("oauth token: only form bodies and known grant types", async () => {
  const t = await oauthFixture();
  const json = await t.app.fetch(
    new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals((await json.json()).error, "invalid_request");
  const r = await token(t.app, { grant_type: "password", client_id: t.clientId });
  assertEquals(r.body.error, "unsupported_grant_type");
});
