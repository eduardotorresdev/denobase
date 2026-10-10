import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../app.ts";
import { type Mail, MemoryMailer } from "../auth/mailer.ts";
import { ensureAuthOriginsTable } from "../auth/alert.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const aa_users = defineCollection({
  slug: "aa_users",
  auth: { otp: { enabled: true }, authAlert: { enabled: true } },
  fields: [],
});
const aa_quiet = defineCollection({ slug: "aa_quiet", auth: true, fields: [] });
registerCollections(aa_users, aa_quiet);

const PW = "12345678";

async function setup(mailer = new MemoryMailer()) {
  const db = await dbWith([superusers, aa_users, aa_quiet]);
  ensureAuthOriginsTable(db);
  const app = createApp({ db, mailer, settings: { meta: { appName: "pbS", appURL: "https://pbs.test" } } });
  for (const col of [aa_users, aa_quiet]) {
    await app.store.collection(col).create(
      { id: "ana", email: "ana@x.io", password: PW, passwordConfirm: PW } as never,
    );
  }
  const login = (ua: string, slug = "aa_users") =>
    app.http.request(`/api/collections/${slug}/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify({ identity: "ana@x.io", password: PW }),
    });
  const origins = () => (db.prepare(`SELECT COUNT(*) n FROM _authOrigins`).get() as { n: number }).n;
  return { db, app, mailer, login, origins };
}

Deno.test("login alert: first login silent, known origin silent, new origin mails PB's template", async () => {
  const t = await setup();
  assertEquals((await t.login("browser-a")).status, 200);
  assertEquals(t.mailer.sent.length, 0);
  await t.login("browser-a");
  assertEquals(t.mailer.sent.length, 0);
  assertEquals(t.origins(), 1);

  assertEquals((await t.login("browser-b <x>")).status, 200);
  assertEquals(t.mailer.sent.length, 1);
  const m = t.mailer.sent[0];
  assertEquals([m.to, m.subject], ["ana@x.io", "Login from a new location"]);
  assertStringIncludes(m.html, "login to your pbS account from a new location");
  assertStringIncludes(m.html, "browser-b &lt;x&gt;");
  assertEquals(t.origins(), 2);
});

Deno.test("login alert: keeps at most 5 origins and is off when the collection does not enable it", async () => {
  const t = await setup();
  for (let i = 0; i < 8; i++) await t.login(`ua-${i}`);
  assertEquals(t.origins(), 5);
  assertEquals(t.mailer.sent.length, 7);

  const q = await setup();
  await q.login("a", "aa_quiet");
  await q.login("b", "aa_quiet");
  assertEquals([q.mailer.sent.length, q.origins()], [0, 0]);
});

Deno.test("login alert: a failing mailer never fails the login, is logged, and the origin is kept", async () => {
  class Broken extends MemoryMailer {
    fail = false;
    override send(m: Mail): Promise<void> {
      if (this.fail) return Promise.reject(new Error("smtp down"));
      return super.send(m);
    }
  }
  const mailer = new Broken();
  const t = await setup(mailer);
  await t.login("a");
  mailer.fail = true;
  assertEquals((await t.login("b")).status, 200);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(t.origins(), 2);
  const logs = t.app.logs.list({ filter: "message~'Failed to send login alert'" }).items;
  assertEquals(logs.length, 1);
  assertStringIncludes(JSON.stringify(logs[0].data), "smtp down");
  // The origin is known now: the same browser logs in again without a second alert.
  mailer.fail = false;
  await t.login("b");
  assertEquals([mailer.sent.length, t.origins()], [0, 2]);
});

Deno.test("login alert: a provider that never answers does not hold the login", async () => {
  class Stuck extends MemoryMailer {
    pending = 0;
    override send(): Promise<void> {
      this.pending++;
      return new Promise(() => {});
    }
  }
  const mailer = new Stuck();
  const t = await setup(mailer);
  await t.login("a");
  const answered = await Promise.race([
    Promise.resolve(t.login("b")).then((r) => r.status),
    new Promise((r) => setTimeout(() => r("timeout"), 2_000)),
  ]);
  assertEquals([answered, mailer.pending, t.origins()], [200, 1, 2]);
});

Deno.test("superusers have the login alert on by default, as PB", () => {
  assertEquals(typeof superusers.auth === "object" && superusers.auth.authAlert?.enabled, true);
});
