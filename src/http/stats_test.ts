import { assert, assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { openDb } from "../core/db.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";
import { dbSizeBytes } from "./stats.ts";
import { RequestStats } from "../telemetry/requests.ts";
import { DatabaseSync } from "node:sqlite";

Deno.env.set("BCRYPT_COST", "4");

const st_users = defineCollection({ slug: "st_users", auth: true, fields: [], access: { read: () => true } });
registerCollections(st_users);

async function setup() {
  const db = await dbWith([superusers, st_users]);
  const app = createApp({ db, mailer: new MemoryMailer(), collections: [superusers, st_users] });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const user = await app.store.collection(st_users).create(
    { email: "u@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const suToken = await tokenFor(db, "_superusers", su);
  const userToken = await tokenFor(db, "st_users", user);
  const get = async (token: string, path = "/api/_denobase/stats") => {
    const r = await app.http.request(path, { headers: token ? { Authorization: token } : {} });
    return { status: r.status, json: await r.json() };
  };
  return { app, get, suToken, userToken };
}

Deno.test("stats: 401 without auth, 403 for a regular user", async () => {
  const t = await setup();
  assertEquals((await t.get("")).status, 401);
  assertEquals((await t.get(t.userToken)).status, 403);
  for (const p of ["traffic", "traces", "jobs", "attention"]) {
    assertEquals((await t.get("", `/api/_denobase/${p}`)).status, 401, p);
    assertEquals((await t.get(t.userToken, `/api/_denobase/${p}`)).status, 403, p);
  }
});

Deno.test("traffic: counts the app's requests by hour, 4xx apart from 5xx, and never the home's own reads", async () => {
  const t = await setup();
  await t.get("", "/api/collections/st_users/records");
  await t.get("", "/api/collections/nope/records");
  await t.get(t.suToken, "/api/_denobase/stats");
  // The admin UI marks its own calls: they stay out of the figures.
  await t.app.http.request("/api/collections/st_users/records", { headers: { "X-Denobase-Admin": "1" } });
  const r = await t.get(t.suToken, "/api/_denobase/traffic");
  assertEquals(r.status, 200);
  assertEquals([r.json.current.total, r.json.current.e4xx, r.json.current.e5xx], [2, 1, 0]);
  assertEquals(r.json.hours.length, 1);
  assert(r.json.current.p95 > 0);
  assertEquals(r.json.previous.total, 0);
});

Deno.test("attention: a failed sign-in burst and a failed cron run are listed with where to act", async () => {
  const t = await setup();
  // Host rules read the real machine (a busy CI box may be loaded): only the app's own rules are asserted.
  const own = (items: { id: string }[]) => items.filter((i) => !i.id.startsWith("host:"));
  assertEquals(own((await t.get(t.suToken, "/api/_denobase/attention")).json.items), []);
  for (let i = 0; i < 10; i++) {
    const r = await t.app.http.request("/api/collections/st_users/auth-with-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "u@x.io", password: "wrong-password" }),
    });
    assertEquals(r.status, 400);
  }
  t.app.cron.add("broken", "0 0 1 1 *", () => {
    throw new Error("boom");
  });
  await t.app.cron.get("broken")!.run("manual").catch(() => {});
  t.app.tracer.flush();
  const list = async () =>
    own((await t.get(t.suToken, "/api/_denobase/attention")).json.items) as {
      id: string;
      severity: string;
      href: string;
    }[];
  const items = await list();
  assertEquals(items.map((i) => i.id).sort(), ["auth:failed", "cron:broken"]);
  const broken = items.find((i) => i.id === "cron:broken")!;
  assertEquals(broken.severity, "error");
  assert(broken.href.startsWith("#/traces/"));
  // A good run afterwards does not hide the day's failure: it turns into a warning.
  t.app.cron.add("broken", "0 0 1 1 *", () => {});
  await t.app.cron.get("broken")!.run("manual");
  t.app.tracer.flush();
  const after = (await list()).find((i) => i.id === "cron:broken")!;
  assertEquals([after.severity, after.href], ["warning", broken.href]);
});

Deno.test("traffic: the last-hour window slides by the minute instead of resetting on the hour", () => {
  const stats = new RequestStats(new DatabaseSync(":memory:"));
  const now = new Date(Date.UTC(2026, 0, 1, 16, 2));
  for (let i = 0; i < 12; i++) stats.record(400, 5, true, new Date(Date.UTC(2026, 0, 1, 15, 58)));
  stats.record(200, 5, false, new Date(Date.UTC(2026, 0, 1, 14, 50))); // more than an hour before now
  stats.flush();
  const o = stats.overview(now);
  assertEquals([o.lastHour.authFailed, o.lastHour.total], [12, 12]);
});

Deno.test("jobs: crons with their last run, and no backup storage without a data dir", async () => {
  const t = await setup();
  t.app.cron.add("nightly", "0 3 * * *", () => {});
  await t.app.cron.get("nightly")!.run("manual");
  t.app.tracer.flush();
  const r = (await t.get(t.suToken, "/api/_denobase/jobs")).json;
  const nightly = r.crons.find((j: { id: string }) => j.id === "nightly");
  assertEquals([nightly.expression, nightly.system, nightly.last.status], ["0 3 * * *", false, "ok"]);
  assertEquals(r.backup.enabled, false);
  assertEquals(r.mailFailed24h, 0);
});

Deno.test("stats: superuser gets host, process and db figures without any path", async () => {
  const t = await setup();
  const r = await t.get(t.suToken);
  assertEquals(r.status, 200);
  const s = r.json;
  for (
    const k of [
      "hostname",
      "os",
      "arch",
      "deno",
      "uptimeSec",
      "cpus",
      "loadavg",
      "memory",
      "process",
      "collections",
      "dbSizeBytes",
    ]
  ) assert(k in s, k);
  assertEquals(s.os, Deno.build.os);
  assertEquals(s.deno, Deno.version.deno);
  assert(s.uptimeSec > 0);
  assert(Array.isArray(s.loadavg));
  assert(s.process.rss > 0 && s.process.heapUsed > 0);
  assertEquals(s.collections, 2);
  // In-memory db: no file to measure.
  assertEquals(s.dbSizeBytes, null);
  assert(!JSON.stringify(s).includes("/"), "no filesystem path leaks");
});

Deno.test("dbSizeBytes measures a file-backed db and is null in memory", () => {
  const file = Deno.makeTempFileSync({ suffix: ".db" });
  const db = openDb(file);
  try {
    db.exec("CREATE TABLE t (x)");
    const size = dbSizeBytes(db);
    assert(size !== null && size > 0);
  } finally {
    db.close();
    Deno.removeSync(file);
  }
  assertEquals(dbSizeBytes(openDb()), null);
});
