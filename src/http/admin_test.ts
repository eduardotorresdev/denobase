import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { openDb } from "../core/db.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { Schedule } from "../cron/mod.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const ad_users = defineCollection({ slug: "ad_users", auth: true, fields: [], access: { read: () => true } });
registerCollections(ad_users);

async function setup(opts: { dataDir?: string; db?: DatabaseSync } = {}) {
  const db = opts.db ?? await dbWith([superusers, ad_users]);
  const mailer = new MemoryMailer();
  let restored = 0;
  const app = createApp({ db, mailer, dataDir: opts.dataDir, onRestored: () => restored++ });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const user = await app.store.collection(ad_users).create(
    { email: "u@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const suToken = await tokenFor(db, "_superusers", su);
  const userToken = await tokenFor(db, "ad_users", user);
  const call = async (method: string, path: string, body?: unknown, token = suToken) => {
    const headers: Record<string, string> = token ? { Authorization: token } : {};
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await app.http.request(path, { method, headers, body: payload });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
  };
  return { db, app, mailer, call, suToken, userToken, restored: () => restored };
}

Deno.test("admin APIs are superuser-only, like PB RequireSuperuserAuth", async () => {
  const t = await setup();
  for (const path of ["/api/settings", "/api/logs", "/api/crons", "/api/backups"]) {
    assertEquals((await t.call("GET", path, undefined, "")).status, 401, path);
    assertEquals((await t.call("GET", path, undefined, t.userToken)).status, 403, path);
  }
});

Deno.test("settings: PB shape without secrets, PATCH merges, validates, persists and applies", async () => {
  const t = await setup();
  const s = (await t.call("GET", "/api/settings")).json;
  assertEquals([s.meta.appName, s.batch.maxRequests, s.logs.maxDays, "password" in s.smtp, "secret" in s.s3], [
    "Acme",
    50,
    5,
    false,
    false,
  ]);
  const bad = await t.call("PATCH", "/api/settings", { meta: { appURL: "nope" }, backups: { cron: "61 * * * *" } });
  assertEquals([bad.status, bad.json.data.meta.appURL.code, bad.json.data.backups.cron.code], [
    400,
    "validation_is_url",
    "validation_invalid_cron",
  ]);
  const ok = await t.call("PATCH", "/api/settings", { meta: { appName: "pbS" }, smtp: { password: "segredo" } });
  assertEquals([ok.json.meta.appName, ok.json.meta.appURL, "password" in ok.json.smtp], [
    "pbS",
    "http://localhost:8090",
    false,
  ]);
  assertEquals(t.app.settings.smtp.password, "segredo");
  // A new app on the same db starts from what was saved.
  assertEquals(createApp({ db: t.db, mailer: t.mailer }).settings.meta.appName, "pbS");
  // Emails pick up the new name right away.
  assertEquals(
    (await t.call("POST", "/api/settings/test/email", { email: "a@x.io", template: "verification" })).status,
    204,
  );
  assertEquals(t.mailer.sent.at(-1)!.subject, "Verify your pbS email");
  assertEquals(
    (await t.call("POST", "/api/settings/test/email", { template: "nope" })).json.data.email.code,
    "validation_required",
  );
});

Deno.test("logs: every request is logged, errors at level 8, with PB's list/filter/stats/view/truncate", async () => {
  const t = await setup();
  await t.call("GET", "/api/health");
  await t.call("GET", "/api/collections/ad_users/records/missing");
  const list = (await t.call("GET", `/api/logs?filter=${encodeURIComponent("data.status >= 400")}&sort=-created`)).json;
  assertEquals(list.totalItems, 1);
  const [log] = list.items;
  assertEquals([log.level, log.message, log.data.type, log.data.status, log.data.method, log.data.auth], [
    8,
    "GET /api/collections/ad_users/records/missing",
    "request",
    404,
    "GET",
    "_superusers",
  ]);
  assertEquals(Object.keys(log), ["id", "created", "data", "message", "level"]);
  assertEquals((await t.call("GET", `/api/logs/${log.id}`)).json.id, log.id);
  assertEquals((await t.call("GET", "/api/logs/nope")).status, 404);
  const stats = (await t.call("GET", "/api/logs/stats")).json;
  assert(stats[0].total >= 2 && /^\d{4}-\d\d-\d\d \d\d:00:00\.000Z$/.test(stats[0].date));
  // Reading logs successfully is not logged (PB SkipSuccessActivityLog).
  const before = (await t.call("GET", "/api/logs?perPage=1")).json.totalItems;
  assertEquals((await t.call("GET", "/api/logs?perPage=1")).json.totalItems, before);
  assertEquals((await t.call("DELETE", "/api/logs")).status, 204);
  assertEquals((await t.call("GET", "/api/logs")).json.totalItems, 0);
});

Deno.test("logs list: skipTotal answers -1 totals and fields picks item keys, like PB", async () => {
  const t = await setup();
  await t.call("GET", "/api/health");
  const r = (await t.call("GET", "/api/logs?skipTotal=1&fields=created,data")).json;
  assertEquals([r.totalItems, r.totalPages], [-1, -1]);
  assert(r.items.length >= 1);
  assertEquals(Object.keys(r.items[0]), ["created", "data"]);
});

Deno.test("cron: PB expressions and macros, UTC schedule, jobs API", async () => {
  const s = new Schedule("*/15 9-17 * * 1-5");
  assert(s.isDue(new Date("2026-10-05T09:30:00Z"))); // Monday
  assert(!s.isDue(new Date("2026-10-04T09:30:00Z"))); // Sunday
  assert(new Schedule("@hourly").isDue(new Date("2026-10-04T03:00:00Z")));
  assertThrows(() => new Schedule("* * *"));
  assertThrows(() => new Schedule("5/2 * * * *"));

  const t = await setup();
  let ran = 0;
  t.app.cron.add("relatorio", "0 0 * * *", () => void ran++);
  const jobs = (await t.call("GET", "/api/crons")).json;
  assertEquals(jobs.map((j: { id: string }) => j.id), [
    "relatorio",
    "__denobaseOAuthCleanup__",
    "__denobaseTracesCleanup__",
    "__denobaseWalCheckpoint__",
    "__denobaseWalTruncate__",
    "__pbDBOptimize__",
    "__pbLogsCleanup__",
    "__pbOTPCleanup__",
  ]);
  assertEquals(jobs[0], { id: "relatorio", expression: "0 0 * * *" });
  assertEquals((await t.call("POST", "/api/crons/relatorio")).status, 204);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(ran, 1);
  assertEquals((await t.call("POST", "/api/crons/nope")).json.message, "Missing or invalid cron job");
  await t.app.cron.tick(new Date("2026-10-04T00:00:00Z"));
  assertEquals(ran, 2);
});

Deno.test("backups: create, list, download with a superuser file token, upload, delete, restore", async () => {
  const dir = await Deno.makeTempDir();
  const db = openDb(`${dir}/data.db`);
  const t = await setup({ dataDir: dir, db: await dbWith([superusers, ad_users], db) });
  await Deno.mkdir(`${dir}/storage/x`, { recursive: true });
  await Deno.writeTextFile(`${dir}/storage/x/a.txt`, "arquivo");

  assertEquals(
    (await t.call("POST", "/api/backups", { name: "Ruim.zip" })).json.data.name.code,
    "validation_match_invalid",
  );
  assertEquals((await t.call("POST", "/api/backups", { name: "manual.zip" })).status, 204);
  assertEquals(
    (await t.call("POST", "/api/backups", { name: "manual.zip" })).json.data.name.code,
    "validation_backup_name_exists",
  );
  assertEquals((await t.call("POST", "/api/backups", {})).status, 204);
  const list = (await t.call("GET", "/api/backups")).json;
  assertEquals(list.length, 2);
  assert(list.some((b: { key: string }) => /^pb_backup_acme_\d{14}\.zip$/.test(b.key)));
  assert(list.every((b: { size: number }) => b.size > 0));

  assertEquals((await t.call("GET", "/api/backups/manual.zip", undefined, "")).status, 403);
  const fileToken = (await t.call("POST", "/api/files/token")).json.token;
  const userFileToken = (await t.call("POST", "/api/files/token", undefined, t.userToken)).json.token;
  assertEquals((await t.app.http.request(`/api/backups/manual.zip?token=${userFileToken}`)).status, 403);
  const dl = await t.app.http.request(`/api/backups/manual.zip?token=${fileToken}`);
  assertEquals([dl.status, dl.headers.get("content-type")], [200, "application/zip"]);
  assertEquals(dl.headers.get("accept-ranges"), "bytes");
  assert(dl.headers.get("last-modified"));
  const whole = new Uint8Array(await dl.arrayBuffer());
  // A resumed download (curl -C -) gets the tail as a 206, like PB's http.ServeContent.
  const part = await t.app.http.request(`/api/backups/manual.zip?token=${fileToken}`, {
    headers: { Range: "bytes=10-" },
  });
  assertEquals(
    [part.status, part.headers.get("content-range")],
    [206, `bytes 10-${whole.length - 1}/${whole.length}`],
  );
  assertEquals(new Uint8Array(await part.arrayBuffer()), whole.slice(10));

  const up = new FormData();
  up.append("file", new File(["not a zip"], "x.zip"));
  assertEquals((await t.call("POST", "/api/backups/upload", up)).json.data.file.code, "validation_invalid_mime_type");
  const good = new FormData();
  good.append(
    "file",
    new File([zipSync({ "data.db": new Uint8Array([1]) }) as Uint8Array<ArrayBuffer>], "enviado.zip"),
  );
  assertEquals((await t.call("POST", "/api/backups/upload", good)).status, 204);
  // Spooled to disk and streamed on: the stored zip is byte for byte the upload.
  const back = await t.app.http.request(`/api/backups/enviado.zip?token=${fileToken}`);
  assertEquals(
    new Uint8Array(await back.arrayBuffer()),
    new Uint8Array(await (good.get("file") as File).arrayBuffer()),
  );
  assertEquals((await t.call("DELETE", "/api/backups/enviado.zip")).status, 204);
  assertEquals((await t.call("DELETE", "/api/backups/enviado.zip")).status, 400);

  // Restore swaps pb_data: the restored storage file is back, today's extra file is gone.
  await Deno.writeTextFile(`${dir}/storage/x/b.txt`, "depois");
  await t.app.backups!.restore("manual.zip");
  assertEquals(t.restored(), 1);
  assertEquals(await Deno.readTextFile(`${dir}/storage/x/a.txt`), "arquivo");
  assertEquals(await Deno.stat(`${dir}/storage/x/b.txt`).then(() => true, () => false), false);
  const restoredDb = openDb(`${dir}/data.db`);
  assertEquals((restoredDb.prepare(`SELECT email FROM _superusers`).get() as { email: string }).email, "su@x.io");
  restoredDb.close();
  db.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("Denobase UI served at /_/ by default, off with false", async () => {
  const t = await setup();
  const ui = createApp({ db: t.db, mailer: t.mailer }).http;
  const redirect = await ui.request("/_");
  assertEquals([redirect.status, redirect.headers.get("location")], [301, "/_/"]);
  const root = await ui.request("/_/");
  assertEquals([root.status, root.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  assertEquals((await root.text()).includes("src/main.js"), true);
  assertEquals((await ui.request("/_/src/main.js")).status, 200);
  assertEquals(await (await ui.request("/_/records/x")).text(), await (await ui.request("/_/")).text());
  assertEquals((await ui.request("/_/%2e%2e/deno.json")).status, 404);
  const off = createApp({ db: t.db, mailer: t.mailer, adminUiDir: false }).http;
  assertEquals((await off.request("/_/")).status, 404);
});

Deno.test("without a data dir the backups API answers PB's filesystem error", async () => {
  const t = await setup();
  assertEquals((await t.call("GET", "/api/backups")).json.message, "Failed to load backups filesystem.");
});

Deno.test("collections API: PB JSON, read-only; admin UI served at /_/ when configured", async () => {
  const t = await setup();
  const list = (await t.call("GET", "/api/collections")).json;
  const users = list.items.find((c: { name: string }) => c.name === "ad_users");
  assertEquals([users.type, users.system, users.id], [
    "auth",
    false,
    (await t.call("GET", "/api/collections/ad_users")).json.id,
  ]);
  assertEquals(users.fields.map((f: { name: string }) => f.name), [
    "id",
    "password",
    "tokenKey",
    "email",
    "emailVisibility",
    "verified",
    "created",
    "updated",
  ]);
  assertEquals([users.listRule, users.createRule], ["// defined in code", null]);
  assertEquals(list.items.find((c: { name: string }) => c.name === "_superusers").system, true);
  assertEquals(Object.keys((await t.call("GET", "/api/collections/meta/scaffolds")).json).sort(), [
    "auth",
    "base",
    "view",
  ]);
  assertEquals((await t.call("GET", "/api/collections/meta/oauth2-providers")).json, []);
  assertEquals((await t.call("POST", "/api/collections", { name: "x" })).status, 400);
  assertEquals((await t.call("DELETE", "/api/collections/ad_users")).status, 400);
  assertEquals((await t.call("GET", "/api/collections", undefined, t.userToken)).status, 403);

  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/index.html`, "<html>pb</html>");
  await Deno.mkdir(`${dir}/assets`);
  await Deno.writeTextFile(`${dir}/assets/app.js`, "1");
  const ui = createApp({ db: t.db, mailer: t.mailer, adminUiDir: dir }).http;
  const root = await ui.request("/_/");
  assertEquals([root.status, await root.text(), root.headers.get("cache-control")], [
    200,
    "<html>pb</html>",
    "no-cache",
  ]);
  const js = await ui.request("/_/assets/app.js");
  assertEquals([js.headers.get("content-type"), await js.text()], ["text/javascript; charset=utf-8", "1"]);
  assertEquals(await (await ui.request("/_/collections")).text(), "<html>pb</html>");
  // An encoded ".." never reads outside the UI dir.
  assertEquals((await ui.request("/_/%2e%2e/secret")).status, 404);
  // /_/api/* is the consumer's: a route mounted after the UI answers it, and without one it is a 404, not the UI.
  const app = createApp({ db: t.db, mailer: t.mailer, adminUiDir: dir });
  app.http.get("/_/api/x.csv", (c) => c.text("csv"));
  assertEquals(await (await app.http.request("/_/api/x.csv")).text(), "csv");
  assertEquals((await app.http.request("/_/api/nada")).status, 404);
  assertEquals(js.headers.get("cache-control"), "no-cache");
  await Deno.remove(dir, { recursive: true });
});
