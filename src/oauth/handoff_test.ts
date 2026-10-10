import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { authorizeQuery, Browser, callback, delivered, hidden, type OAuthFixture, oauthFixture } from "./testkit.ts";

const WEB = "https://web.example/oauth";

/** The consumer's handoff page, played by the test: what it does with the request id it is sent. */
async function webPage(t: OAuthFixture, location: string, auth: string | null): Promise<string> {
  const u = new URL(location);
  assertEquals(u.origin + u.pathname, WEB);
  // Only the request id travels: nothing names the collection.
  assertEquals([...u.searchParams.keys()], ["oauth_txn"]);
  const txn = u.searchParams.get("oauth_txn")!;
  const back = `/oauth/authorize?txn=${encodeURIComponent(txn)}`;
  if (!auth) return back;
  const res = await t.app.fetch(
    new Request("http://localhost/oauth/handoff", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: auth },
      body: JSON.stringify({ txn }),
    }),
  );
  if (res.status !== 200) return back;
  const url = new URL((await res.json()).url);
  return url.pathname + url.search;
}

/** authorize -> silent handoff page -> back: the page the browser lands on after the redirects. */
async function silent(t: OAuthFixture, b: Browser, auth: string | null, extra: Record<string, string> = {}) {
  const first = await b.get(authorizeQuery(t.clientId, extra));
  assertEquals(first.status, 303);
  let res = await b.get(await webPage(t, first.headers.get("location")!, auth));
  while (
    res.status === 303 && new URL(res.headers.get("location")!, "http://localhost").pathname === "/oauth/authorize"
  ) {
    const loc = new URL(res.headers.get("location")!, "http://localhost");
    res = await b.get(loc.pathname + loc.search);
  }
  return res;
}

const neutral = (html: string) => html.replaceAll(hidden(html, "txn"), "TXN").replaceAll(hidden(html, "csrf"), "CSRF");

Deno.test("oauth silent handoff: a web session of the request's collection goes straight to consent", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const b = new Browser(t.app);
  const res = await silent(t, b, t.anaSession, { auth_collection: "mt_users" });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "ana@x.io");
  assertStringIncludes(html, 'name="action"');
  const txn = hidden(html, "txn");
  await delivered(await b.post("/oauth/consent", { txn, csrf: hidden(html, "csrf"), action: "allow" }));
});

Deno.test("oauth silent handoff: no token, or one of another collection, ends on the same login page, once", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const none = await silent(t, new Browser(t.app), null, { auth_collection: "_superusers" });
  const other = await silent(t, new Browser(t.app), t.anaSession, { auth_collection: "_superusers" });
  assertEquals(none.status, 200);
  assertEquals(other.status, 200);
  const a = neutral(await none.text());
  const o = neutral(await other.text());
  assertEquals(o, a);
  assertStringIncludes(a, 'action="/oauth/login"');
  for (const s of ["_superusers", "mt_users", "sessão", "session", WEB]) assertFalse(a.includes(s), s);
});

Deno.test("oauth silent handoff: tried once per request, never a loop, even by hand", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const b = new Browser(t.app);
  const first = await b.get(authorizeQuery(t.clientId));
  assertEquals(first.status, 303);
  const txn = new URL(first.headers.get("location")!).searchParams.get("oauth_txn")!;
  for (let i = 0; i < 3; i++) {
    const again = await b.get(`/oauth/authorize?txn=${txn}`);
    assertEquals(again.status, 200);
    assertStringIncludes(await again.text(), 'action="/oauth/login"');
  }
  const row = t.app.db.prepare(`SELECT webTried FROM _oauth_requests WHERE id = ?`).get(txn) as { webTried: number };
  assertEquals(row.webTried, 1);
});

Deno.test("oauth silent handoff: prompt=login skips it and a handoff code does not sign in", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const b = new Browser(t.app);
  const res = await b.get(authorizeQuery(t.clientId, { prompt: "login" }));
  assertEquals(res.status, 200);
  const txn = hidden(await res.text(), "txn");
  const code = await t.app.fetch(
    new Request("http://localhost/oauth/handoff", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: t.anaSession },
      body: JSON.stringify({ txn }),
    }),
  );
  const url = new URL((await code.json()).url);
  const back = await b.get(url.pathname + url.search);
  assertEquals(back.status, 303);
  assert(!b.cookie.includes("denobase_oauth="));
  const page = await b.get(back.headers.get("location")!);
  assertStringIncludes(await page.text(), 'action="/oauth/login"');
});

Deno.test("oauth silent handoff: prompt=none tries it, then answers login_required without one", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const b = new Browser(t.app);
  const res = await silent(t, b, null, { prompt: "none" });
  assertEquals(callback(res).searchParams.get("error"), "login_required");
});

Deno.test("oauth silent handoff: prompt=none with a web session of the request's collection still needs consent", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const res = await silent(t, new Browser(t.app), t.anaSession, { prompt: "none" });
  assertEquals(callback(res).searchParams.get("error"), "consent_required");
});

Deno.test("oauth silent handoff: a spent, expired or other browser's code ends on the login page", async () => {
  const t = await oauthFixture({ webLogin: { url: WEB } });
  const b = new Browser(t.app);
  const first = await b.get(authorizeQuery(t.clientId));
  const txn = new URL(first.headers.get("location")!).searchParams.get("oauth_txn")!;
  const code = async () => {
    const res = await t.app.fetch(
      new Request("http://localhost/oauth/handoff", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: t.anaSession },
        body: JSON.stringify({ txn }),
      }),
    );
    const u = new URL((await res.json()).url);
    return u.pathname + u.search;
  };
  const toLogin = async (br: Browser, path: string) => {
    const back = await br.get(path);
    assertEquals(back.status, 303);
    assertFalse(br.cookie.includes("denobase_oauth="));
    assertStringIncludes(await (await br.get(back.headers.get("location")!)).text(), 'action="/oauth/login"');
  };
  // Another browser.
  await toLogin(new Browser(t.app), await code());
  // Expired: a minute later.
  const late = await code();
  const now = Date.now;
  Date.now = () => now() + 61_000;
  try {
    await b.get(late);
  } finally {
    Date.now = now;
  }
  assertFalse(b.cookie.includes("denobase_oauth="));
  // Spent: used once, then again.
  const once = await code();
  assertEquals((await b.get(once)).status, 303);
  const b2 = new Browser(t.app);
  b2.cookie = b.cookie.split("; ").filter((p) => !p.startsWith("denobase_oauth=")).join("; ");
  await toLogin(b2, once);
});
