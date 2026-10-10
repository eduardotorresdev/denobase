import { assert, assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { openDb } from "../core/db.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";
import { dbSizeBytes } from "./stats.ts";

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
  const get = async (token: string) => {
    const r = await app.http.request("/api/_denobase/stats", { headers: token ? { Authorization: token } : {} });
    return { status: r.status, json: await r.json() };
  };
  return { get, suToken, userToken };
}

Deno.test("stats: 401 without auth, 403 for a regular user", async () => {
  const t = await setup();
  assertEquals((await t.get("")).status, 401);
  assertEquals((await t.get(t.userToken)).status, 403);
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
