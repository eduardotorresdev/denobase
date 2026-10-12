import { assert, assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { MemoryStorage } from "../files/storage.ts";
import { FILES_MIGRATION_TOPIC } from "../files/migrate.ts";
import { dbWith, startFakeS3, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const mig_docs = defineCollection({
  slug: "mig_docs",
  fields: [{ name: "anexo", type: "file" }],
  access: { read: () => true, create: () => true },
});
registerCollections(mig_docs);

async function setup() {
  const db = await dbWith([superusers, mig_docs]);
  const local = new MemoryStorage();
  const app = createApp({ db, mailer: new MemoryMailer(), storage: local });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const token = await tokenFor(db, "_superusers", su);
  const call = async (method: string, path: string, body?: unknown, auth: string | null = token) => {
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
  return { app, local, call };
}

const BASE = "/api/_denobase/files-migration";

Deno.test("saving settings.s3 proposes a migration; superusers start it and follow it over realtime", async () => {
  const s3 = startFakeS3();
  const t = await setup();
  const published: { topic: string; data: { status: string } }[] = [];
  const publish = t.app.realtime.publish.bind(t.app.realtime);
  t.app.realtime.publish = (topic, data, opts) => {
    published.push({ topic, data: data as { status: string } });
    return publish(topic, data, opts);
  };
  try {
    const f = new FormData();
    f.append("anexo", new File(["hello"], "a.txt", { type: "text/plain" }));
    const rec = (await t.call("POST", "/api/collections/mig_docs/records", f)).json;
    const url = `/api/files/${rec.collectionId}/${rec.id}/${rec.anexo}`;

    assertEquals((await t.call("GET", BASE)).json, null);
    assertEquals((await t.call("PATCH", "/api/settings", { s3: s3.config })).status, 200);
    const proposal = (await t.call("GET", BASE)).json;
    assertEquals([proposal.status, proposal.from], ["proposed", "local"]);
    assert(!JSON.stringify(proposal).includes(s3.config.secret));
    // No read fallback: the file is 404 until copied.
    assertEquals((await t.app.http.request(url)).status, 404);

    const plan = (await t.call("GET", `${BASE}/plan`)).json;
    assertEquals([plan.id, plan.from, plan.total, plan.toCopy, plan.bytes], [proposal.id, "local", 1, 1, 5]);
    assertEquals((await t.call("GET", `${BASE}/plan`, undefined, null)).status, 401);
    assertEquals((await t.call("GET", BASE, undefined, null)).status, 401);
    assertEquals((await t.call("POST", BASE, {}, null)).status, 401);

    const started = await t.call("POST", BASE, { deleteSource: true });
    assertEquals([started.status, started.json.status, started.json.deleteSource], [200, "running", true]);
    const again = await t.call("POST", BASE, {});
    assertEquals([again.status, again.json.data?.code ?? again.json.code], [409, "files_migration_active"]);
    await t.app.filesMigration.running;

    const done = (await t.call("GET", BASE)).json;
    assertEquals([done.status, done.copied, done.failed], ["done", 1, 0]);
    assertEquals(t.local.files.size, 0);
    const res = await t.app.http.request(url);
    assertEquals([res.status, await res.text()], [200, "hello"]);
    assert(published.every((p) => p.topic === FILES_MIGRATION_TOPIC));
    assertEquals(published.at(-1)?.data.status, "done");

    assertEquals((await t.call("POST", `${BASE}/cancel`)).status, 404);
    assertEquals((await t.call("POST", `${BASE}/resume`)).status, 404);
  } finally {
    await t.app.terminate();
    await s3.close();
  }
});
