import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import { renderPage } from "./pages.ts";
import { resolveOAuthOptions } from "./options.ts";
import { Browser, delivered, ISSUER, oauthFixture, REDIRECT, register, toConsent } from "./testkit.ts";

/** The page with its tags removed: what the user reads. */
const visible = (html: string) => html.replace(/<[^>]*>/g, " ");

Deno.test("oauth done: allowing a loopback client shows the final page and delivers code, state and iss in a hidden frame", async () => {
  const t = await oauthFixture();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  const res = await b.post("/oauth/consent", { txn, csrf, action: "allow" });
  const html = await res.clone().text();
  const u = await delivered(res);
  const code = u.searchParams.get("code")!;
  assert(code);
  assertEquals([u.searchParams.get("state"), u.searchParams.get("iss")], ["st-1", ISSUER]);
  assertMatch(html, /<iframe class="oa-deliver" src="http:\/\/127\.0\.0\.1:33418\/callback\?code=[^"]+" sandbox /);
  assertStringIncludes(html, "Access authorized");
  assertStringIncludes(html, "ana@x.io");
  assertStringIncludes(html, "close this tab");
  assertStringIncludes(html, "<svg");
  assertFalse(html.includes("http-equiv"));
  assertFalse(visible(html).includes(code));
  // Headers: no script, the loopback origin is the only frame, nothing cached, no referrer, never framed.
  const csp = res.headers.get("content-security-policy")!;
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "frame-src http://127.0.0.1:33418;");
  assertStringIncludes(csp, "frame-ancestors 'none'");
  assertFalse(csp.includes("script-src"));
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  assertEquals(res.headers.get("x-frame-options"), "DENY");
});

Deno.test("oauth done: denying shows 'access denied' and delivers error=access_denied", async () => {
  const t = await oauthFixture({ locale: "pt-BR" });
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, t.clientId);
  const res = await b.post("/oauth/consent", { txn, csrf, action: "deny" });
  const html = await res.clone().text();
  const u = await delivered(res);
  assertEquals([u.searchParams.get("error"), u.searchParams.get("code")], ["access_denied", null]);
  assertEquals(u.searchParams.get("state"), "st-1");
  assertStringIncludes(html, "Acesso recusado");
  assertStringIncludes(html, "Você pode fechar esta aba e voltar para o aplicativo.");
  assertStringIncludes(html, 'class="oa-done-icon oa-no"');
});

Deno.test("oauth done: a web redirect shows the page, then the browser goes on to the app", async () => {
  const t = await oauthFixture();
  const web = "https://app.example/cb";
  const reg = await (await register(t.app, { redirect_uris: [web], token_endpoint_auth_method: "none" })).json();
  const b = new Browser(t.app);
  const { txn, csrf } = await toConsent(b, reg.client_id, undefined, { redirect_uri: web });
  const res = await b.post("/oauth/consent", { txn, csrf, action: "allow" });
  const html = await res.clone().text();
  const u = await delivered(res, web);
  assert(u.searchParams.get("code"));
  assertMatch(html, /<meta http-equiv="refresh" content="2;url=https:\/\/app\.example\/cb\?code=/);
  assertFalse(html.includes("<iframe"));
  assertFalse(res.headers.get("content-security-policy")!.includes("frame-src"));
});

Deno.test("oauth done: names are escaped on the final page", () => {
  const html = renderPage(resolveOAuthOptions(), "done", {
    appName: "App",
    allowed: true,
    clientName: "<script>x</script>",
    email: "<b>a</b>",
    returnUrl: `${REDIRECT}?code=c&state="><script>`,
    loopback: true,
  });
  assertFalse(html.includes("<script>"));
  assertStringIncludes(html, "&lt;script&gt;x");
  assertStringIncludes(html, "code=c&amp;state=&quot;&gt;");
});
