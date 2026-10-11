import { assertEquals, assertThrows } from "@std/assert";
import { Cli, UsageError } from "../engine.ts";
import { fromS3, storageCommand } from "./storage.ts";
import { FsStorage } from "../../files/storage.ts";
import { startFakeS3 } from "../../testing/mod.ts";
import { openDb } from "../../core/db.ts";
import { FilesMigrations } from "../../files/migrate.ts";
import { CurrentStorage } from "../../files/current.ts";

async function seed(dir: string, keys: string[]): Promise<FsStorage> {
  const fs = new FsStorage(`${dir}/storage`);
  for (const k of keys) await fs.put(k, new TextEncoder().encode(k), { type: "text/plain" });
  return fs;
}

async function keysOf(fs: FsStorage): Promise<string[]> {
  const out: string[] = [];
  for await (const b of fs.list("")) out.push(b.key);
  return out.sort();
}

Deno.test("storage migrate: --to must be the current storage; dry run writes nothing; local -> s3 moves the files", async () => {
  const dir = await Deno.makeTempDir();
  const s3 = startFakeS3();
  const quiet = console.log;
  console.log = () => {};
  try {
    const local = await seed(dir, ["c1/r1/a.txt", "c1/r2/b.txt"]);
    const db = ["--db", `${dir}/data.db`];
    const onS3 = new Cli([storageCommand({ settings: { s3: s3.config } })]);
    const onLocal = new Cli([storageCommand()]);

    assertEquals(await onS3.run(["storage", "migrate", "--from", "local", "--to", "local", ...db]), 1);
    assertEquals(await onLocal.run(["storage", "migrate", "--from", "local", "--to", "s3", ...db]), 1);
    assertEquals(await onS3.run(["storage", "migrate", "--from", "ftp", "--to", "s3", ...db]), 2);

    assertEquals(await onS3.run(["storage", "migrate", "--from", "local", "--to", "s3", "--dry-run", ...db]), 0);
    assertEquals(s3.objects.size, 0);

    const args = ["storage", "migrate", "--from", "local", "--to", "s3", "--delete-source", ...db];
    assertEquals(await onS3.run(args), 0);
    assertEquals([...s3.objects.keys()].sort(), ["c1/r1/a.txt", "c1/r2/b.txt"]);
    assertEquals(await keysOf(local), []);

    // And back, with the old bucket's credentials from the environment.
    const env = {
      DENOBASE_FROM_S3_BUCKET: s3.config.bucket,
      DENOBASE_FROM_S3_REGION: s3.config.region,
      DENOBASE_FROM_S3_ENDPOINT: s3.config.endpoint,
      DENOBASE_FROM_S3_ACCESS_KEY: s3.config.accessKey,
      DENOBASE_FROM_S3_SECRET: s3.config.secret,
      DENOBASE_FROM_S3_FORCE_PATH_STYLE: "true",
    };
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    try {
      assertEquals(await onLocal.run(["storage", "migrate", "--from", "s3", "--to", "local", ...db]), 0);
    } finally {
      for (const k of Object.keys(env)) Deno.env.delete(k);
    }
    assertEquals(await keysOf(local), ["c1/r1/a.txt", "c1/r2/b.txt"]);
    assertEquals(s3.objects.size, 2);
  } finally {
    console.log = quiet;
    await s3.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("storage migrate: a running job is followed, and taken over once its lease expired", async () => {
  const dir = await Deno.makeTempDir();
  const s3 = startFakeS3();
  const quiet = console.log;
  const lines: string[] = [];
  console.log = (s: string) => void lines.push(s);
  try {
    await seed(dir, ["c1/r1/a.txt"]);
    const cli = new Cli([storageCommand({ settings: { s3: s3.config } })]);
    const db = ["--db", `${dir}/data.db`];
    // A job some process started and abandoned (lease long expired).
    const aux = openDb(`${dir}/auxiliary.db`);
    const data = openDb(`${dir}/data.db`);
    const mig = new FilesMigrations({
      aux,
      data,
      storage: new CurrentStorage(new FsStorage(`${dir}/storage`)),
      s3: () => s3.config,
      launch: () => Promise.resolve(),
    });
    const job = await mig.create({ from: { kind: "local" } });
    aux.close();
    data.close();

    assertEquals(await cli.run(["storage", "migrate", "--from", "local", "--to", "s3", ...db]), 0);
    assertEquals(lines[0].includes("already running"), true);
    assertEquals(s3.objects.has("c1/r1/a.txt"), true);
    assertEquals(lines.at(-1)?.startsWith("[done] 1/1"), true);
    assertEquals(typeof job.id, "string");
  } finally {
    console.log = quiet;
    await s3.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fromS3: flags win over DENOBASE_FROM_S3_*, missing fields are a usage error", () => {
  const ctx = (flags: Record<string, string | true>) => ({
    flags,
    str: (n: string) => (typeof flags[n] === "string" ? flags[n] as string : undefined),
  });
  const env = {
    DENOBASE_FROM_S3_BUCKET: "env-bucket",
    DENOBASE_FROM_S3_REGION: "r",
    DENOBASE_FROM_S3_ENDPOINT: "https://e",
    DENOBASE_FROM_S3_ACCESS_KEY: "k",
    DENOBASE_FROM_S3_SECRET: "s",
  };
  const cfg = fromS3(ctx({ "from-s3-bucket": "flag-bucket", "from-s3-force-path-style": true }), env);
  assertEquals([cfg.bucket, cfg.region, cfg.forcePathStyle, cfg.enabled], ["flag-bucket", "r", true, true]);
  assertThrows(() => fromS3(ctx({}), {}), UsageError, "bucket, region, endpoint, accessKey, secret");
});
