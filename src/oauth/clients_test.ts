import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { redirectMatches, redirectUriProblem } from "./clients.ts";
import { authorizeQuery, Browser, oauthFixture, register } from "./testkit.ts";

const rules = { allowLoopback: true, allowedRedirectHosts: [] as string[] };

Deno.test("oauth clients: a loopback redirect matches on any port, never on another path or host", () => {
  const reg = ["http://127.0.0.1:3000/callback"];
  assert(redirectMatches("http://127.0.0.1:61234/callback", reg));
  assertFalse(redirectMatches("http://127.0.0.1:61234/other", reg));
  assertFalse(redirectMatches("http://localhost:3000/callback", reg));
  assertFalse(redirectMatches("https://app.example/callback", ["https://app.example/callback/"]));
  assert(redirectMatches("https://app.example/cb", ["https://app.example/cb"]));
  assertFalse(redirectMatches("https://app.example:8443/cb", ["https://app.example/cb"]));
});

Deno.test("oauth clients: http outside loopback, fragments, wildcards and credentials are refused", () => {
  assertEquals(redirectUriProblem("https://app.example/cb", rules), null);
  assertEquals(redirectUriProblem("http://[::1]:9/cb", rules), null);
  assert(redirectUriProblem("http://app.example/cb", rules));
  assert(redirectUriProblem("https://app.example/cb#x", rules));
  assert(redirectUriProblem("https://*.example/cb", rules));
  assert(redirectUriProblem("https://u:p@app.example/cb", rules));
  assert(redirectUriProblem("javascript:alert(1)", rules));
  assert(redirectUriProblem("http://127.0.0.1/cb", { ...rules, allowLoopback: false }));
  assert(redirectUriProblem("https://other.example/cb", { ...rules, allowedRedirectHosts: ["app.example"] }));
});

Deno.test("oauth clients: DCR limits (redirect count, auth method, grant types, unknown scope)", async () => {
  const t = await oauthFixture();
  const err = async (body: unknown) => (await (await register(t.app, body)).json()).error;
  assertEquals(await err({ redirect_uris: [] }), "invalid_redirect_uri");
  assertEquals(await err({ redirect_uris: Array(11).fill("https://a.example/cb") }), "invalid_redirect_uri");
  assertEquals(
    await err({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" }),
    "invalid_client_metadata",
  );
  assertEquals(
    await err({ redirect_uris: ["https://a.example/cb"], grant_types: ["password"] }),
    "invalid_client_metadata",
  );
  assertEquals(await err({ redirect_uris: ["https://a.example/cb"], scope: "root" }), "invalid_client_metadata");
});

Deno.test("oauth clients: DCR can be switched off in settings", async () => {
  const t = await oauthFixture();
  t.app.settings.oauth.dcrEnabled = false;
  assertEquals((await register(t.app, { redirect_uris: ["https://a.example/cb"] })).status, 403);
  const meta = await (await t.app.fetch(new Request("http://localhost/.well-known/oauth-authorization-server"))).json();
  assertEquals(meta.registration_endpoint, undefined);
});

Deno.test("oauth authorize: an unknown client or unregistered redirect_uri is a page, never a redirect", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const unknown = await b.get(authorizeQuery("nope"));
  assertEquals([unknown.status, unknown.headers.get("location")], [400, null]);
  const bad = await b.get(authorizeQuery(t.clientId, { redirect_uri: "https://evil.example/callback" }));
  assertEquals([bad.status, bad.headers.get("location")], [400, null]);
  assertStringIncludes(await bad.text(), "not registered");
});

Deno.test("oauth authorize: S256 and a valid challenge are required (errors go back to the client)", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const err = async (extra: Record<string, string>) => {
    const res = await b.get(authorizeQuery(t.clientId, extra));
    assertEquals(res.status, 303);
    return new URL(res.headers.get("location")!).searchParams.get("error");
  };
  // No state (the MCP SDK default): PKCE binds the code, the sign-in page opens.
  const noState = await b.get(authorizeQuery(t.clientId, { state: "" }));
  assertEquals(noState.status, 200);
  assertEquals(await err({ code_challenge_method: "plain" }), "invalid_request");
  assertEquals(await err({ code_challenge: "short" }), "invalid_request");
  assertEquals(await err({ response_type: "token" }), "unsupported_response_type");
  assertEquals(await err({ resource: "https://elsewhere.example/api/mcp" }), "invalid_target");
  assertEquals(await err({ prompt: "none" }), "login_required");
});
