import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { connect, rpc } from "../mcp/testkit.ts";
import { authorizeCode, Browser, exchange, oauthFixture } from "./testkit.ts";
import { resolveRequestedScopes, scopeRegistry, toolAllowed } from "./scopes.ts";

async function tokenWith(scope: string, oauth = {}) {
  const t = await oauthFixture(oauth);
  const code = await authorizeCode(new Browser(t.app), t.clientId, undefined, { scope });
  const r = await exchange(t.app, t.clientId, code);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return { t, access: r.body.access_token as string };
}

Deno.test("oauth scopes: mcp:read lists only read-only tools and a write call is 403 insufficient_scope", async () => {
  const { t, access } = await tokenWith("mcp:read");
  const c = await connect(t.app, access);
  const names = (await c.listTools()).tools.map((x) => x.name);
  assert(names.includes("db_list"));
  assertFalse(names.includes("db_create"));
  await c.close();
  const call = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "db_create", arguments: { collection: "mt_notas", data: { titulo: "x" } } },
  };
  const res = await rpc(t.app, call, { Authorization: `Bearer ${access}` });
  assertEquals(res.status, 403);
  assertMatch(res.headers.get("WWW-Authenticate")!, /^Bearer error="insufficient_scope", scope="mcp:write"/);
  assertEquals(t.app.db.prepare(`SELECT COUNT(*) AS n FROM mt_notas WHERE titulo = 'x'`).get(), { n: 0 });
});

Deno.test("oauth scopes: an app scope opens exactly its tools", async () => {
  const { t, access } = await tokenWith("saude", {
    scopes: [{ name: "saude", description: "Health only.", tools: ["db_health"] }],
  });
  const c = await connect(t.app, access);
  assertEquals((await c.listTools()).tools.map((x) => x.name), ["db_health"]);
  await c.close();
});

Deno.test("oauth scopes: unknown or not registered scopes are refused; the default is mcp", () => {
  const known = scopeRegistry();
  assertEquals(resolveRequestedScopes("", known, ""), ["mcp"]);
  assertEquals(resolveRequestedScopes("mcp nope", known, ""), null);
  assertEquals(resolveRequestedScopes("mcp:write", known, "mcp:read"), null);
  assert(toolAllowed({ name: "x", readOnly: false }, undefined, known));
  assertFalse(toolAllowed({ name: "x", readOnly: false }, ["offline_access"], known));
});

Deno.test("oauth scopes: an unknown scope at authorize goes back as invalid_scope", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const res = await b.get(
    "/oauth/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: t.clientId,
      redirect_uri: "http://127.0.0.1:33418/callback",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "admin:everything",
    }),
  );
  assertEquals(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_scope");
});
