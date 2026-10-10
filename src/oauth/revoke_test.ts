import { assertEquals } from "@std/assert";
import { INITIALIZE, rpc } from "../mcp/testkit.ts";
import { oauthFixture, token, tokens } from "./testkit.ts";

function post(
  app: { fetch: (r: Request) => Response | Promise<Response> },
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return Promise.resolve(app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  ));
}

Deno.test("oauth revoke: a refresh token's family goes; unknown tokens still answer 200", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  assertEquals((await post(t.app, "/oauth/revoke", { client_id: t.clientId, token: tk.refresh_token })).status, 200);
  const r = await token(t.app, { grant_type: "refresh_token", client_id: t.clientId, refresh_token: tk.refresh_token });
  assertEquals(r.body.error, "invalid_grant");
  assertEquals((await post(t.app, "/oauth/revoke", { client_id: t.clientId, token: "nope" })).status, 200);
});

Deno.test("oauth revoke: an access token revokes its grant (gid), so /api/mcp refuses it at once", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  assertEquals((await post(t.app, "/oauth/revoke", { client_id: t.clientId, token: tk.access_token })).status, 200);
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: `Bearer ${tk.access_token}` })).status, 401);
});

Deno.test("oauth revoke: another client cannot revoke someone else's token", async () => {
  const t = await oauthFixture();
  const tk = await tokens(t);
  const other = await (await t.app.fetch(
    new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://x.example/cb"], token_endpoint_auth_method: "none" }),
    }),
  )).json();
  await post(t.app, "/oauth/revoke", { client_id: other.client_id, token: tk.access_token });
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: `Bearer ${tk.access_token}` })).status, 200);
});

Deno.test("oauth introspect: off by default; on, a superuser sees active and inactive tokens", async () => {
  const off = await oauthFixture();
  assertEquals((await post(off.app, "/oauth/introspect", { token: "x" })).status, 404);
  const t = await oauthFixture({ introspection: true });
  const tk = await tokens(t);
  const look = async (tok: string, auth: string) =>
    await (await post(t.app, "/oauth/introspect", { token: tok }, { Authorization: auth })).json();
  const a = await look(tk.access_token, t.suSession);
  assertEquals([a.active, a.scope, a.client_id, a.sub], [true, "mcp", t.clientId, t.ana.id]);
  assertEquals((await look("garbage", t.suSession)).active, false);
  assertEquals((await post(t.app, "/oauth/introspect", { token: tk.access_token, client_id: t.clientId })).status, 401);
});
