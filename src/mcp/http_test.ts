import { assert, assertEquals, assertMatch } from "@std/assert";
import { connect, fixture, INITIALIZE, rpc } from "./testkit.ts";

Deno.test("mcp http: GET and DELETE answer 405 (stateless, no sessions), behind the same auth as POST", async () => {
  const t = await fixture();
  assertEquals((await rpc(t.app, null, { Authorization: t.suToken }, "GET")).status, 405);
  assertEquals((await rpc(t.app, null, { Authorization: t.suToken }, "DELETE")).status, 405);
  assertEquals((await rpc(t.app, null, {}, "GET")).status, 401);
  assertEquals((await rpc(t.app, null, { Authorization: t.anaSession }, "GET")).status, 401);
});

Deno.test("mcp http: without a token, 401 with WWW-Authenticate pointing at the resource metadata", async () => {
  const t = await fixture();
  const r = await rpc(t.app, INITIALIZE);
  assertEquals(r.status, 401);
  assertMatch(
    r.headers.get("WWW-Authenticate") ?? "",
    /^Bearer resource_metadata="http:\/\/localhost:8090\/\.well-known\/oauth-protected-resource"$/,
  );
  const meta = await (await t.app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource"))).json();
  assertEquals(meta.resource, "http://localhost:8090/api/mcp");
  // The embedded authorization server (src/oauth) is the issuer, on the same origin.
  assertEquals(meta.authorization_servers, ["http://localhost:8090"]);
  const off = await fixture({ mcp: { oauth: { enabled: false } } });
  const none = await (await off.app.fetch(new Request("http://localhost/.well-known/oauth-protected-resource")))
    .json();
  assertEquals(none.authorization_servers, []);
  assertEquals(
    (await off.app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))).status,
    404,
  );
});

Deno.test("mcp http: an invalid token is a guest, so also 401", async () => {
  const t = await fixture();
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: "Bearer garbage" })).status, 401);
});

Deno.test("mcp http: a browser Origin outside the allowlist is 403; localhost and listed origins pass", async () => {
  const t = await fixture({ mcp: { allowedOrigins: ["https://ok.example"] } });
  const auth = { Authorization: t.suToken };
  assertEquals((await rpc(t.app, INITIALIZE, { ...auth, Origin: "https://evil.example" })).status, 403);
  assertEquals((await rpc(t.app, INITIALIZE, { ...auth, Origin: "http://localhost:5173" })).status, 200);
  assertEquals((await rpc(t.app, INITIALIZE, { ...auth, Origin: "https://ok.example" })).status, 200);
});

Deno.test("mcp http: by default a session token is refused and app.mcp.token's is accepted", async () => {
  const t = await fixture();
  const plain = await rpc(t.app, INITIALIZE, { Authorization: t.anaSession });
  assertEquals(plain.status, 401);
  assertMatch(plain.headers.get("WWW-Authenticate") ?? "", /error="invalid_token"/);
  const scoped = await t.app.mcp.token("mt_users", t.ana.id, { ttl: 3600 });
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: scoped })).status, 200);
  const off = await fixture({ mcp: { requireAudience: false } });
  assertEquals((await rpc(off.app, INITIALIZE, { Authorization: off.anaSession })).status, 200);
});

Deno.test("mcp http: an MCP token is scoped to /api/mcp; the REST API treats it as a guest", async () => {
  const t = await fixture();
  const list = async (token: string) => {
    const req = new Request("http://localhost/api/collections/mt_notas/records", { headers: { Authorization: token } });
    return await (await t.app.fetch(req)).json();
  };
  assertEquals((await list(t.anaSession)).items.length, 1);
  assertEquals((await list(t.anaToken)).items?.length ?? 0, 0);
});

Deno.test("mcp http: without appURL the token is minted for the given baseURL and the check uses the same base", async () => {
  const t = await fixture();
  t.app.settings.meta.appURL = "";
  await t.app.mcp.token("mt_users", t.ana.id).then(() => {
    throw new Error("minted without a base");
  }, () => {});
  const tok = await t.app.mcp.token("mt_users", t.ana.id, { baseURL: "http://localhost" });
  assertEquals((await rpc(t.app, INITIALIZE, { Authorization: tok })).status, 200);
});

Deno.test("mcp http: the legacy initialize handshake answers server info and capabilities", async () => {
  const t = await fixture();
  const r = await rpc(t.app, INITIALIZE, { Authorization: t.anaToken });
  assertEquals(r.status, 200);
  const text = await r.text();
  const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  assertEquals(body.result.serverInfo.name, "denobase");
  // A 2025 stateless request has no stream for list_changed, so it does not claim it.
  assertEquals(body.result.capabilities.tools.listChanged, false);
  assert(body.result.capabilities.resources);
  assert(body.result.capabilities.prompts);
});

Deno.test("mcp http: both protocol eras serve the same tools through the SDK client", async () => {
  const t = await fixture();
  for (const mode of ["legacy", "modern"] as const) {
    const c = await connect(t.app, t.anaToken, mode);
    const names = (await c.listTools()).tools.map((x) => x.name);
    assert(names.includes("db_list"), mode);
    await c.close();
  }
});

Deno.test("mcp http: a tool call logs one mcp line and the POST itself is not activity-logged", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  await c.callTool({ name: "db_health", arguments: {} });
  await c.close();
  const lines = t.app.logs.list({ perPage: 100 }).items;
  const mcp = lines.filter((l) => l.data.type === "mcp");
  assertEquals(mcp.map((l) => [l.data.tool, l.data.isError, l.data.authId]), [["db_health", false, t.ana.id]]);
  assertEquals(lines.filter((l) => String(l.message).includes("/api/mcp")), []);
});
