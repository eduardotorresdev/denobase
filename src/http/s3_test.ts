import { assert, assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { MemoryStorage } from "../files/storage.ts";
import { dbWith, startFakeS3, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const s3_docs = defineCollection({
  slug: "s3_docs",
  fields: [{ name: "anexo", type: "file" }],
  access: { read: () => true, create: () => true, update: () => true, delete: () => true },
});
registerCollections(s3_docs);

async function setup() {
  const db = await dbWith([superusers, s3_docs]);
  const local = new MemoryStorage();
  const app = createApp({ db, mailer: new MemoryMailer(), storage: local });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const token = await tokenFor(db, "_superusers", su);
  const call = async (method: string, path: string, body?: unknown, auth = token) => {
    const headers: Record<string, string> = auth ? { Authorization: auth } : {};
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = await app.http.request(path, { method, headers, body: payload });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const upload = async (name: string, body: string) => {
    const f = new FormData();
    f.append("anexo", new File([body], name, { type: "text/plain" }));
    return (await call("POST", "/api/collections/s3_docs/records", f)).json;
  };
  return { app, local, call, upload };
}

Deno.test("saving settings.s3 swaps the files storage: uploads, serving with Range and deletes go to S3", async () => {
  const s3 = startFakeS3();
  const t = await setup();
  try {
    const before = await t.upload("a.txt", "local file");
    assertEquals(t.local.files.size, 1);

    assertEquals((await t.call("PATCH", "/api/settings", { s3: s3.config })).status, 200);
    const rec = await t.upload("b.txt", "0123456789");
    const key = `${rec.collectionId}/${rec.id}/${rec.anexo}`;
    assertEquals([t.local.files.size, s3.objects.get(key)?.type], [1, "text/plain; charset=utf-8"]);

    const res = await t.app.http.request(`/api/files/${rec.collectionId}/${rec.id}/${rec.anexo}`, {
      headers: { range: "bytes=3-5" },
    });
    assertEquals([res.status, res.headers.get("content-range"), await res.text()], [206, "bytes 3-5/10", "345"]);
    // No read fallback: a file left on the old storage is 404 until migrated.
    const old = await t.app.http.request(`/api/files/${before.collectionId}/${before.id}/${before.anexo}`);
    assertEquals(old.status, 404);
    await old.body?.cancel();

    assertEquals((await t.call("DELETE", `/api/collections/s3_docs/records/${rec.id}`)).status, 204);
    // Record files are removed after commit, without awaiting.
    for (let i = 0; i < 50 && s3.objects.has(key); i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(s3.objects.has(key), false);

    assertEquals((await t.call("PATCH", "/api/settings", { s3: { enabled: false } })).status, 200);
    const back = await t.app.http.request(`/api/files/${before.collectionId}/${before.id}/${before.anexo}`);
    assertEquals(await back.text(), "local file");
  } finally {
    await t.app.terminate();
    await s3.close();
  }
});

Deno.test("an enabled settings.s3 must be complete, like PB's S3Config.Validate", async () => {
  const t = await setup();
  try {
    const r = await t.call("PATCH", "/api/settings", { s3: { enabled: true, bucket: "b" } });
    assertEquals(r.status, 400);
    assertEquals(Object.keys(r.json.data.s3).sort(), ["accessKey", "endpoint", "region", "secret"]);
    const b = await t.call("PATCH", "/api/settings", { backups: { s3: { enabled: true } } });
    assertEquals(b.json.data.backups.s3.bucket.code, "validation_required");
  } finally {
    await t.app.terminate();
  }
});

Deno.test("POST /api/settings/test/s3 answers like PB for each filesystem", async () => {
  const s3 = startFakeS3();
  const t = await setup();
  try {
    let r = await t.call("POST", "/api/settings/test/s3", {});
    assertEquals([r.status, r.json.data.filesystem.code], [400, "validation_required"]);
    r = await t.call("POST", "/api/settings/test/s3", { filesystem: "other" });
    assertEquals(r.json.data.filesystem.code, "validation_in_invalid");
    r = await t.call("POST", "/api/settings/test/s3", { filesystem: "storage" });
    assertEquals(r.status, 400);
    assertEquals(r.json.message, "Failed to test the S3 filesystem. Raw error: \nS3 storage filesystem is not enabled");

    await t.call("PATCH", "/api/settings", { s3: s3.config, backups: { s3: { ...s3.config, secret: "bad" } } });
    assertEquals((await t.call("POST", "/api/settings/test/s3", { filesystem: "storage" })).status, 204);
    const put = s3.requests.find((q) => q.method === "PUT")!;
    assert(/^pb_settings_test\/[a-z0-9]{5}\.txt$/.test(put.key));
    assertEquals(s3.objects.size, 0); // the probe deletes what it wrote

    r = await t.call("POST", "/api/settings/test/s3", { filesystem: "backups" });
    assertEquals(r.status, 400);
    assert(r.json.message.includes("SignatureDoesNotMatch"));
    assertEquals((await t.call("POST", "/api/settings/test/s3", { filesystem: "storage" }, "")).status, 401);
  } finally {
    await t.app.terminate();
    await s3.close();
  }
});

Deno.test("POST /api/_denobase/s3/check walks a draft step by step and says what to fix", async () => {
  const s3 = startFakeS3({ region: "eu-west-1" });
  const t = await setup();
  const check = (s3cfg: object, filesystem = "backups") =>
    t.call("POST", "/api/_denobase/s3/check", { filesystem, s3: s3cfg });
  const statuses = (r: { json: { steps: { id: string; status: string }[] } }) =>
    r.json.steps.map((x) => `${x.id}:${x.status}`).join(" ");
  try {
    let r = await check(s3.config);
    assertEquals(r.status, 200);
    assertEquals(r.json.ok, true);
    assertEquals(statuses(r), "connect:ok auth:ok bucket:ok write:ok read:ok cleanup:ok");
    assertEquals(s3.objects.size, 0); // the probe never stays
    // Nothing was saved: a draft check leaves the settings alone.
    assertEquals((await t.call("GET", "/api/settings")).json.backups.s3.enabled, false);

    r = await check({ ...s3.config, region: "us-east-1" });
    assertEquals([r.json.ok, r.json.suggest], [false, { region: "eu-west-1" }]);
    assertEquals(statuses(r), "connect:ok auth:fail bucket:skip write:skip read:skip cleanup:skip");

    r = await check({ ...s3.config, secret: "bad" });
    assertEquals(r.json.steps[1].code, "SignatureDoesNotMatch");

    r = await check({ ...s3.config, bucket: "nope" });
    assertEquals(statuses(r), "connect:ok auth:ok bucket:fail write:skip read:skip cleanup:skip");

    s3.failWhen = (q) => (q.method === "PUT" ? 500 : undefined);
    r = await check(s3.config);
    assertEquals(statuses(r), "connect:ok auth:ok bucket:ok write:fail read:skip cleanup:skip");
    s3.failWhen = undefined;

    // A host without DNS for bucket subdomains: connect fails and path style is suggested.
    r = await check({ ...s3.config, endpoint: "http://localhost:1", forcePathStyle: false });
    assertEquals([r.json.steps[0].status, r.json.suggest], ["fail", { forcePathStyle: true }]);

    r = await check({ ...s3.config, endpoint: "https://<account>.example.com" });
    assertEquals([r.status, r.json.steps[0].code], [200, "InvalidEndpoint"]);

    // The saved secret fills an empty one only for the key it was saved with, and only for its filesystem.
    await t.call("PATCH", "/api/settings", { backups: { s3: s3.config } });
    assertEquals((await check({ ...s3.config, secret: "" })).json.ok, true);
    r = await check({ ...s3.config, secret: "", accessKey: "OTHER" });
    assertEquals([r.status, r.json.data.secret.code], [400, "validation_required"]);
    assertEquals((await check({ ...s3.config, secret: "" }, "storage")).status, 400);

    assertEquals((await check(s3.config, "other")).json.data.filesystem.code, "validation_in_invalid");
    const anon = await t.call("POST", "/api/_denobase/s3/check", { filesystem: "storage", s3: s3.config }, "");
    assertEquals(anon.status, 401);
  } finally {
    await t.app.terminate();
    await s3.close();
  }
});

Deno.test("a storage that fails to delete after commit is logged, never an unhandled rejection", async () => {
  const t = await setup();
  const logged: unknown[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a[0]);
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => void warned.push(a[0]);
  try {
    const down = () => Promise.reject(new Error("S3 503 Slow Down"));
    t.local.delete = down;
    t.local.deletePrefix = down;
    const a = await t.upload("a.txt", "x");
    const f = new FormData();
    f.append("anexo", new File(["y"], "b.txt", { type: "text/plain" }));
    assertEquals((await t.call("PATCH", `/api/collections/s3_docs/records/${a.id}`, f)).status, 200);
    assertEquals((await t.call("DELETE", `/api/collections/s3_docs/records/${a.id}`)).status, 204);
    for (let i = 0; i < 50 && logged.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(logged, ["Failed to delete files", "Failed to delete files"]);
    // The dropped file's thumbs are a warning apart, like PB's.
    assertEquals(warned, ["Failed to delete file thumbs"]);
  } finally {
    console.error = err;
    console.warn = warn;
    await t.app.terminate();
  }
});
