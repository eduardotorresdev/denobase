import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { pageHeaders, renderPage } from "./pages.ts";
import { messages } from "./messages.ts";
import { BUILTIN_SCOPES } from "./scopes.ts";
import { resolveOAuthOptions } from "./options.ts";
import { authorizeQuery, Browser, hidden, oauthFixture, register, toConsent, txnCsrf } from "./testkit.ts";

Deno.test("oauth pages: client name and logo are escaped (no markup injection)", () => {
  const html = renderPage(resolveOAuthOptions(), "consent", {
    appName: "App",
    txn: "t",
    csrf: "c",
    client: {
      name: "<script>alert(1)</script>",
      logoUri: 'https://x.example/l.png" onerror="alert(1)',
      kind: "dcr",
      id: "id",
      unverified: true,
    },
    redirectHost: "127.0.0.1:1",
    loopback: true,
    resource: "r",
    scopes: [{ name: "mcp", description: "<b>x</b>" }],
    user: { email: "a@b" },
  });
  assertFalse(html.includes("<script>"));
  assertFalse(html.includes('" onerror="'));
  assertStringIncludes(html, "&lt;script&gt;");
  assertStringIncludes(html, "Unverified");
});

Deno.test("oauth pages: CSP without scripts, no framing, no referrer, no caching", () => {
  const h = pageHeaders("http://127.0.0.1:5000");
  assertStringIncludes(h["Content-Security-Policy"], "default-src 'none'");
  assertStringIncludes(h["Content-Security-Policy"], "form-action 'self';");
  assertStringIncludes(h["Content-Security-Policy"], "frame-src http://127.0.0.1:5000;");
  assertFalse(h["Content-Security-Policy"].includes("script-src"));
  assertStringIncludes(h["Content-Security-Policy"], "frame-ancestors 'none'");
  assertEquals([h["X-Frame-Options"], h["Referrer-Policy"], h["Cache-Control"]], ["DENY", "no-referrer", "no-store"]);
});

Deno.test("oauth pages: a registered name with markup reaches the consent page escaped", async () => {
  const t = await oauthFixture();
  const reg = await (await register(t.app, {
    redirect_uris: ["http://127.0.0.1:33418/callback"],
    client_name: '"><img src=x onerror=alert(1)>',
    token_endpoint_auth_method: "none",
  })).json();
  const { html } = await toConsent(new Browser(t.app), reg.client_id);
  assertFalse(html.includes("<img src=x"));
  const login = await new Browser(t.app).get(authorizeQuery(reg.client_id));
  assertEquals(login.headers.get("x-frame-options"), "DENY");
  assertStringIncludes(login.headers.get("content-security-policy")!, "default-src 'none'");
});

Deno.test("oauth pages: the stylesheet is served from /oauth/assets with the branding accent", async () => {
  const t = await oauthFixture({ branding: { accentColor: "#ff0000" } });
  const css = await (await t.app.fetch(new Request("http://localhost/oauth/assets/oauth.css"))).text();
  assertStringIncludes(css, ".oa-card");
  assertStringIncludes(css, "--oa-accent: #ff0000");
  // The admin UI's tokens, from the same file it imports.
  assertStringIncludes(css, '@import url("tokens.css")');
  const tokens = await (await t.app.fetch(new Request("http://localhost/oauth/assets/tokens.css"))).text();
  assertStringIncludes(tokens, "--blue: #1a4bff");
});

Deno.test("oauth pages: in pt-BR, login, code, consent, error, expired and handoff pages carry no English UI text and label the consent items", async () => {
  const en = messages("en");
  const pt = messages("pt-BR");
  // The old English set: every English message, the built-in scopes' descriptions and the raw labels.
  const english = [
    ...Object.values(en).filter((v): v is string => typeof v === "string" && v !== en.lang),
    ...Object.values(en.scopeText),
    ...BUILTIN_SCOPES.map((s) => s.description ?? ""),
    en.notYou(),
    "Scope",
    "client_id",
    "redirect_uri",
  ].filter((s) => s.length > 3);
  const t = await oauthFixture({ locale: "pt-BR" });
  const b = new Browser(t.app);
  const login = await (await b.get(authorizeQuery(t.clientId))).text();
  const txn = hidden(login, "txn");
  const otp = await (await b.post("/oauth/otp/request", { txn, csrf: txnCsrf(t.app, txn), email: "ana@x.io" })).text();
  const { html: consent } = await toConsent(new Browser(t.app), t.clientId, { email: "ana@x.io" }, {
    scope: "mcp mcp:read mcp:write offline_access",
  });
  const errors = Object.values(pt).filter((v): v is string => typeof v === "string").map((v) =>
    renderPage(resolveOAuthOptions({ locale: "pt-BR" }), "error", { appName: "Acme", title: v, message: v })
  );
  const expired = await (await new Browser(t.app).get("/oauth/authorize?txn=nao-existe")).text();
  // The silent handoff: no web app session, so it lands back on the request's login page.
  const handoff = await new Browser(t.app).get(authorizeQuery(t.clientId));
  const handoffPage = handoff.status === 303
    ? await (await new Browser(t.app).get(handoff.headers.get("location")!)).text()
    : await handoff.text();
  assertStringIncludes(expired, pt.requestExpired);
  for (const page of [login, otp, consent, expired, handoffPage, ...errors]) {
    for (const s of english) assertFalse(page.includes(s), s);
  }
  // The labeled items, in this order, then the buttons.
  const order = [
    "Quem está pedindo",
    "Com qual conta",
    "Não é você?",
    "Usar outra conta",
    "O que poderá fazer",
    "Usar as ferramentas MCP respeitando as suas permissões",
    "Só ferramentas de leitura, sem alterar nada",
    "Todas as ferramentas MCP, limitadas ao que você pode fazer",
    "Continuar conectado mesmo quando você não estiver usando",
    "Onde será usado",
    "Recurso",
    "Volta para",
    "Detalhes técnicos",
    "Id do aplicativo",
    "Permissões",
    "Recusar",
    "Autorizar",
  ];
  let at = -1;
  for (const s of order) {
    const i = consent.indexOf(s, at + 1);
    assert(i > at, `${s} missing or out of order`);
    at = i;
  }
  assertStringIncludes(consent, "Só ferramentas de leitura, sem alterar nada");
  assertStringIncludes(consent, "localhost:8090/api/mcp");
});
