import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openDb } from "../core/db.ts";
import { CurrentStorage } from "./current.ts";
import { MemoryStorage, readAll } from "./storage.ts";
import { FilesMigrations, openSource, runMigration, sealSource } from "./migrate.ts";
import { startFakeS3 } from "../testing/mod.ts";
import type { S3Config } from "../settings/model.ts";

const OFF: S3Config = {
  enabled: false,
  bucket: "",
  region: "",
  endpoint: "",
  accessKey: "",
  secret: "",
  forcePathStyle: false,
};

function setup(s3: S3Config) {
  const aux = openDb(":memory:");
  const data = openDb(":memory:");
  const local = new MemoryStorage();
  const storage = new CurrentStorage(local);
  const settings = { s3: OFF };
  const runs: string[] = [];
  const mig = new FilesMigrations({
    aux,
    data,
    storage,
    s3: () => settings.s3,
    // Deferred like a job dispatch: the run reads the settings as they are when it starts.
    launch: async (id) => {
      runs.push(id);
      await Promise.resolve();
      return await runMigration(id, { aux, data, storage, s3: settings.s3 });
    },
  });
  const switchTo = async (next: S3Config) => {
    const prev = settings.s3;
    settings.s3 = next;
    storage.use(next);
    await mig.proposeFrom(prev, next);
  };
  return { aux, data, local, storage, settings, mig, runs, switchTo, s3 };
}

const put = (s: MemoryStorage, key: string, body: string) =>
  s.put(key, new TextEncoder().encode(body), { type: "text/plain" });

Deno.test("the source credentials are sealed with AES-GCM and open back", async () => {
  const data = openDb(":memory:");
  const src = { kind: "s3" as const, s3: { ...OFF, enabled: true, bucket: "b", secret: "TOP-SECRET" } };
  const sealed = await sealSource(data, src);
  assert(!sealed.includes("TOP-SECRET") && !atob(sealed.slice(3)).includes("TOP-SECRET"));
  assertEquals(await openSource(data, sealed), src);
  // Another db holds another key: the aux row alone is useless.
  await assertRejects(() => openSource(openDb(":memory:"), sealed));
});

Deno.test("local -> S3: copies, skips same size, overwrites another size, ignores non-record keys", async () => {
  const fake = startFakeS3({ maxKeys: 2 });
  const t = setup(fake.config);
  try {
    await put(t.local, "c1/r1/a.txt", "alpha");
    await put(t.local, "c1/r1/b.txt", "bravo");
    await put(t.local, "c1/r2/c.txt", "charlie");
    await put(t.local, "c1/r2/thumbs_c.png/10x10_c.png", "thumb");
    await put(t.local, "stray.txt", "not a record file");
    await t.switchTo(fake.config);
    // Already there with the same size: skipped; another size: overwritten.
    await t.storage.target.put("c1/r1/b.txt", new TextEncoder().encode("BRAVO"), { type: "text/plain" });
    await t.storage.target.put("c1/r2/c.txt", new TextEncoder().encode("old"), { type: "text/plain" });

    const proposed = t.mig.status()!;
    assertEquals([proposed.status, proposed.from, proposed.to], [
      "proposed",
      "local",
      `s3:${fake.config.bucket}@${fake.endpoint}`,
    ]);
    await t.mig.start();
    await t.mig.running;
    const s = t.mig.status()!;
    assertEquals(
      [s.status, s.total, s.processed, s.copied, s.skipped, s.failed],
      ["done", 4, 4, 3, 1, 0],
    );
    assertEquals(new TextDecoder().decode(fake.objects.get("c1/r2/c.txt")!.data), "charlie");
    assertEquals(fake.objects.get("c1/r1/a.txt")!.type, "text/plain");
    assert(fake.objects.has("c1/r2/thumbs_c.png/10x10_c.png"));
    assert(!fake.objects.has("stray.txt"));
    // Not asked to: the source stays.
    assertEquals(t.local.files.size, 5);
  } finally {
    await fake.close();
  }
});

Deno.test("delete-source runs only at the end and only with zero failures; a resume retries the failures", async () => {
  const fake = startFakeS3();
  const t = setup(fake.config);
  try {
    for (const k of ["a", "b", "c"]) await put(t.local, `c1/r1/${k}.txt`, k);
    await t.switchTo(fake.config);
    fake.failWhen = (r) => (r.method === "PUT" && r.key === "c1/r1/b.txt" ? 500 : undefined);
    await t.mig.start({ deleteSource: true });
    await t.mig.running;
    let s = t.mig.status()!;
    assertEquals([s.status, s.copied, s.failed, s.failures.map((f) => f.key)], ["failed", 2, 1, ["c1/r1/b.txt"]]);
    assertStringIncludes(s.error, "1 file(s)");
    assertEquals(t.local.files.size, 3);

    fake.failWhen = undefined;
    t.mig.resume();
    await t.mig.running;
    s = t.mig.status()!;
    assertEquals([s.status, s.copied, s.skipped, s.failed, s.failures], ["done", 1, 2, 0, []]);
    assertEquals([t.local.files.size, fake.objects.size], [0, 3]);
  } finally {
    await fake.close();
  }
});

Deno.test("S3 -> local, a stalled run is taken over from its cursor, a live lease is not", async () => {
  const fake = startFakeS3();
  const t = setup(OFF);
  try {
    for (const k of ["a", "b", "c"]) {
      fake.objects.set(`c1/r1/${k}.txt`, {
        data: new TextEncoder().encode(k),
        type: "text/plain",
        modified: new Date(),
      });
    }
    t.settings.s3 = fake.config;
    t.storage.use(fake.config);
    await t.switchTo(OFF);
    assertEquals(t.mig.status()!.from, `s3:${fake.config.bucket}@${fake.endpoint}`);
    const job = await t.mig.create();
    // Someone else's run got to "a" and then died holding a lease that is still valid.
    t.aux.prepare(`UPDATE _files_migrations SET owner = 'other', leaseUntil = ?, cursor = 'c1/r1/a.txt' WHERE id = ?`)
      .run(Date.now() + 60_000, job.id);
    assertEquals(await runMigration(job.id, { ...t, s3: OFF }), false);
    assertEquals(t.mig.active()!.stalled, false);
    t.aux.prepare(`UPDATE _files_migrations SET leaseUntil = 1 WHERE id = ?`).run(job.id);
    assertEquals(t.mig.active()!.stalled, true);
    t.mig.resume();
    await t.mig.running;
    const s = t.mig.status()!;
    assertEquals([s.status, s.processed, s.copied], ["done", 2, 2]);
    assertEquals([...t.local.files.keys()].sort(), ["c1/r1/b.txt", "c1/r1/c.txt"]);
    assertEquals(new TextDecoder().decode(await readAll((await t.local.get("c1/r1/c.txt"))!.body)), "c");
  } finally {
    await fake.close();
  }
});

Deno.test("one running job at a time; cancel stops it; a changed target fails the run", async () => {
  const fake = startFakeS3();
  const t = setup(fake.config);
  try {
    await put(t.local, "c1/r1/a.txt", "a");
    await t.switchTo(fake.config);
    const job = await t.mig.create();
    await assertRejects(() => t.mig.create({ from: { kind: "local" } }), Error, "already running");
    // The unique index is the lock even for a writer that skips the check.
    assertEquals(
      (() => {
        try {
          t.aux.prepare(
            `INSERT INTO _files_migrations (id, status, source, sourceLabel, target, created, updated)
             VALUES ('x', 'running', '', '', '', '', '')`,
          ).run();
          return "inserted";
        } catch {
          return "refused";
        }
      })(),
      "refused",
    );
    assertEquals(t.mig.cancel().status, "canceled");
    assertEquals(await runMigration(job.id, { ...t, s3: fake.config }), false);
    assertEquals(fake.objects.size, 0);

    // Resuming the canceled job while the settings point elsewhere is refused.
    t.settings.s3 = OFF;
    assertEquals(
      (() => {
        try {
          t.mig.resume();
          return "";
        } catch (e) {
          return (e as { code?: string }).code ?? (e as Error).message;
        }
      })(),
      "files_migration_target_changed",
    );
    t.settings.s3 = fake.config;
    t.mig.resume();
    t.settings.s3 = OFF;
    await t.mig.running;
    const s = t.mig.status()!;
    assertEquals(s.status, "failed");
    assertStringIncludes(s.error, "changed to local");
  } finally {
    await fake.close();
  }
});

Deno.test("no proposal without a storage change; same source and target is refused", async () => {
  const t = setup(OFF);
  await t.mig.proposeFrom(OFF, { ...OFF, bucket: "ignored while off" });
  assertEquals(t.mig.status(), null);
  await assertRejects(() => t.mig.create(), Error, "no previous storage");
  await assertRejects(() => t.mig.create({ from: { kind: "local" } }), Error, "already uses");
});

Deno.test("one bucket under two endpoint spellings is one storage: delete-source never deletes the destination", async () => {
  const fake = startFakeS3();
  const t = setup(OFF);
  try {
    fake.objects.set("c1/r1/a.txt", { data: new TextEncoder().encode("a"), type: "text/plain", modified: new Date() });
    // Same bucket, the endpoint written another way: equal labels after resolving, refused up front.
    const slash = { ...fake.config, endpoint: `${fake.endpoint}/` };
    t.settings.s3 = fake.config;
    t.storage.use(fake.config);
    await assertRejects(() => t.mig.create({ from: { kind: "s3", s3: slash } }), Error, "already uses");
    // A host alias the labels cannot see through: the run's probe finds the marker at the source and deletes nothing.
    const alias = { ...fake.config, endpoint: fake.endpoint.replace("127.0.0.1", "localhost") };
    const job = await t.mig.create({ from: { kind: "s3", s3: alias }, deleteSource: true });
    await runMigration(job.id, { ...t, s3: () => t.settings.s3 });
    const s = t.mig.get(job.id)!;
    assertEquals(s.status, "failed");
    assertStringIncludes(s.error, "same storage");
    assertEquals([...fake.objects.keys()], ["c1/r1/a.txt"]);
  } finally {
    await fake.close();
  }
});

Deno.test("a settings.s3 change mid-run stops the run before more copies or any source delete", async () => {
  const a = startFakeS3();
  const b = startFakeS3();
  const t = setup(OFF);
  try {
    for (const k of ["a", "b", "c"]) await put(t.local, `c1/r1/${k}.txt`, k);
    await t.switchTo(a.config);
    const job = await t.mig.create({ deleteSource: true });
    // The superuser saves another bucket while the first file is being copied.
    const get = t.local.get.bind(t.local);
    t.local.get = (key, opts) => {
      t.settings.s3 = b.config;
      t.storage.use(b.config);
      return get(key, opts);
    };
    await runMigration(job.id, { ...t, s3: () => t.settings.s3 });
    const s = t.mig.get(job.id)!;
    assertEquals(s.status, "failed");
    assertStringIncludes(s.error, "changed to");
    assertEquals([a.objects.size, t.local.files.size], [1, 3]);
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test("a run that lost its job to another owner neither finishes it nor deletes the source", async () => {
  const fake = startFakeS3();
  const t = setup(OFF);
  try {
    for (const k of ["a", "b"]) await put(t.local, `c1/r1/${k}.txt`, k);
    await t.switchTo(fake.config);
    const job = await t.mig.create({ deleteSource: true });
    // While the last file copies, another process takes the job over (this run's lease looked expired).
    const get = t.local.get.bind(t.local);
    t.local.get = (key, opts) => {
      if (key === "c1/r1/b.txt") {
        t.aux.prepare(`UPDATE _files_migrations SET owner = 'other', leaseUntil = ? WHERE id = ?`)
          .run(Date.now() + 60_000, job.id);
      }
      return get(key, opts);
    };
    assertEquals(await runMigration(job.id, { ...t, s3: () => t.settings.s3 }), true);
    const s = t.mig.get(job.id)!;
    assertEquals([s.status, s.finished], ["running", ""]);
    assertEquals(t.local.files.size, 2);
  } finally {
    await fake.close();
  }
});
