import { assert, assertEquals, assertRejects } from "@std/assert";
import { amzDate, signature } from "./sigv4.ts";
import { S3Error } from "./client.ts";
import { MULTIPART_THRESHOLD, S3Storage } from "./storage.ts";
import { readAll } from "../storage.ts";
import { CurrentStorage, storageFromSettings } from "../current.ts";
import { MemoryStorage } from "../storage.ts";
import { startFakeS3 } from "../../testing/fake_s3.ts";

const text = (s: string) => new TextEncoder().encode(s);
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

Deno.test("sigv4 matches AWS's published GET Object example", async () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  const { signature: sig } = await signature({
    method: "GET",
    path: "/test.txt",
    query: [],
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    amzDate: "20130524T000000Z",
    region: "us-east-1",
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  assertEquals(sig, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assertEquals(amzDate(new Date("2013-05-24T00:00:00.123Z")), "20130524T000000Z");
});

Deno.test("S3Storage: put/get/stat/delete keep bytes and Content-Type, odd keys included", async () => {
  const s3 = startFakeS3();
  try {
    const st = new S3Storage(s3.config);
    for (const key of ["col/rec/a.png", "col/rec/with space+plus&amp.txt", "col/rec/ção (1)*.txt"]) {
      await st.put(key, text("hello"), { type: "image/png" });
      assertEquals(s3.objects.get(key)?.type, "image/png");
      const got = (await st.get(key))!;
      assertEquals([got.size, got.type, new TextDecoder().decode(await readAll(got.body))], [5, "image/png", "hello"]);
      const info = (await st.stat(key))!;
      assertEquals([info.key, info.size, info.type], [key, 5, "image/png"]);
      assert(Math.abs(info.modified.getTime() - Date.now()) < 5000);
      await st.delete(key);
      assertEquals(await st.stat(key), null);
      assertEquals(await st.get(key), null);
    }
    await st.delete("col/missing"); // absent is fine
    await st.put("t", new Uint8Array(), { type: "" });
    assertEquals((await st.stat("t"))?.size, 0);
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: ranged get answers the slice with the whole size; past the end is empty", async () => {
  const s3 = startFakeS3();
  try {
    const st = new S3Storage(s3.config);
    await st.put("k", text("0123456789"), { type: "text/plain" });
    const mid = (await st.get("k", { range: { start: 2, end: 4 } }))!;
    assertEquals([mid.size, new TextDecoder().decode(await readAll(mid.body))], [10, "234"]);
    const tail = (await st.get("k", { range: { start: 7 } }))!;
    assertEquals(new TextDecoder().decode(await readAll(tail.body)), "789");
    const past = (await st.get("k", { range: { start: 50 } }))!;
    assertEquals([past.size, (await readAll(past.body)).byteLength], [10, 0]);
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: list pages through continuation tokens; deletePrefix batches DeleteObjects", async () => {
  const s3 = startFakeS3({ maxKeys: 2 });
  try {
    const st = new S3Storage(s3.config);
    for (const k of ["a/1", "a/2", "a/3", "a/4", "a/5", "b/1", "ab/1"]) await st.put(k, text(k), { type: "" });
    const listed = (await Array.fromAsync(st.list("a/"))).map((i) => [i.key, i.size]);
    assertEquals(listed, [["a/1", 3], ["a/2", 3], ["a/3", 3], ["a/4", 3], ["a/5", 3]]);
    assertEquals(s3.requests.filter((r) => r.query["list-type"] === "2").length, 3);
    await st.deletePrefix("a/");
    assertEquals([...s3.objects.keys()].sort(), ["ab/1", "b/1"]);
    assert(s3.requests.some((r) => r.method === "POST" && "delete" in r.query));
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: streams past the part size go multipart; a stream that fits is one PUT", async () => {
  const s3 = startFakeS3({ minPartSize: 1024 });
  try {
    const st = new S3Storage(s3.config);
    st.partSize = 1024;
    const data = bytes(3500);
    // Odd chunk sizes so parts are cut across chunk boundaries.
    const chunks = [data.subarray(0, 700), data.subarray(700, 2100), data.subarray(2100, 2101), data.subarray(2101)];
    await st.put("big", streamOf(chunks), { type: "application/octet-stream" });
    assertEquals(s3.objects.get("big")?.data, data);
    assertEquals(s3.objects.get("big")?.type, "application/octet-stream");
    assertEquals(s3.requests.filter((r) => r.key === "big" && r.query.partNumber).length, 4);
    assertEquals(s3.uploads.size, 0);

    s3.requests.length = 0;
    await st.put("exact", streamOf([bytes(512), bytes(512, 2)]), { type: "" });
    assertEquals(s3.objects.get("exact")?.data.byteLength, 1024);
    assertEquals(s3.requests.map((r) => [r.method, Object.keys(r.query).length]), [["PUT", 0]]);

    // Bytes above the part size are split too.
    await st.put("bytes", bytes(2500), { type: "" });
    assertEquals(s3.objects.get("bytes")?.data, bytes(2500));
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: the default threshold is 8MB, so a 9MB upload is two parts", async () => {
  const s3 = startFakeS3();
  try {
    const st = new S3Storage(s3.config);
    const data = bytes(MULTIPART_THRESHOLD + 1024 * 1024);
    await st.put("nine", streamOf([data]), { type: "video/mp4" });
    assertEquals(s3.objects.get("nine")?.data.byteLength, data.byteLength);
    assertEquals(s3.requests.filter((r) => r.query.partNumber).map((r) => r.query.partNumber), ["1", "2"]);
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: a failed part aborts the multipart upload and nothing is stored", async () => {
  const s3 = startFakeS3({ minPartSize: 16 });
  try {
    const st = new S3Storage(s3.config);
    st.partSize = 16;
    s3.failWhen = (r) => (r.query.partNumber === "2" ? 500 : undefined);
    const err = await assertRejects(() => st.put("x", streamOf([bytes(40)]), { type: "" }), S3Error);
    assertEquals([err.status, err.code], [500, "InternalError"]);
    assertEquals(s3.uploads.size, 0);
    assert(s3.requests.some((r) => r.method === "DELETE" && r.query.uploadId));
    assertEquals(s3.objects.has("x"), false);
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: a wrong secret is refused by signature check", async () => {
  const s3 = startFakeS3();
  try {
    const st = new S3Storage({ ...s3.config, secret: "wrong" });
    const err = await assertRejects(() => st.put("k", text("x"), { type: "" }), S3Error);
    assertEquals([err.status, err.code], [403, "SignatureDoesNotMatch"]);
    // HEAD answers carry no body: the status still makes a clear error.
    await assertRejects(() => st.stat("k"), S3Error);
  } finally {
    await s3.close();
  }
});

Deno.test("S3Storage: virtual-host style puts the bucket in the host, path style in the path", async () => {
  // bucket.<host> does not resolve locally and fetch will not forge Host, so the URLs are checked at the fetcher.
  const seen: URL[] = [];
  const stub: typeof fetch = (input) => {
    seen.push(new URL(input instanceof Request ? input.url : String(input)));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const cfg = {
    enabled: true,
    bucket: "bkt",
    region: "eu-west-1",
    endpoint: "https://s3.example.com/base",
    accessKey: "a",
    secret: "s",
    forcePathStyle: false,
  };
  await new S3Storage(cfg, stub).put("c/r/a b.txt", text("x"), { type: "" });
  await new S3Storage({ ...cfg, forcePathStyle: true }, stub).put("c/r/a b.txt", text("x"), { type: "" });
  await new S3Storage({ ...cfg, endpoint: "s3.example.com" }, stub).delete("k");
  assertEquals(seen.map((u) => u.href), [
    "https://bkt.s3.example.com/base/c/r/a%20b.txt",
    "https://s3.example.com/base/bkt/c/r/a%20b.txt",
    "https://bkt.s3.example.com/k",
  ]);
});

Deno.test("storageFromSettings and CurrentStorage follow s3.enabled", async () => {
  const s3 = startFakeS3();
  try {
    const local = new MemoryStorage();
    assertEquals(storageFromSettings({ ...s3.config, enabled: false }, local), local);
    assert(storageFromSettings(s3.config, local) instanceof S3Storage);
    const cur = new CurrentStorage(local);
    await cur.put("a", text("local"), { type: "" });
    cur.use(s3.config);
    const first = cur.target;
    cur.use({ ...s3.config });
    assertEquals(cur.target, first); // same config: same client
    await cur.put("a", text("remote"), { type: "" });
    assertEquals(new TextDecoder().decode(s3.objects.get("a")?.data), "remote");
    cur.use({ ...s3.config, enabled: false });
    assertEquals(cur.target, local);
    assertEquals(new TextDecoder().decode(await readAll((await cur.get("a"))!.body)), "local");
  } finally {
    await s3.close();
  }
});

// Real S3-compatible server, only when pointed at one (e.g. `docker run -p 9000:9000 minio/minio server /data`).
const minio = Deno.env.get("DENOBASE_TEST_S3_ENDPOINT");
Deno.test({
  name: "S3Storage against a real S3 (DENOBASE_TEST_S3_*)",
  ignore: !minio,
  async fn() {
    const st = new S3Storage({
      enabled: true,
      endpoint: minio!,
      bucket: Deno.env.get("DENOBASE_TEST_S3_BUCKET") ?? "denobase-test",
      region: Deno.env.get("DENOBASE_TEST_S3_REGION") ?? "us-east-1",
      accessKey: Deno.env.get("DENOBASE_TEST_S3_ACCESS_KEY") ?? "minioadmin",
      secret: Deno.env.get("DENOBASE_TEST_S3_SECRET") ?? "minioadmin",
      forcePathStyle: Deno.env.get("DENOBASE_TEST_S3_PATH_STYLE") !== "false",
    });
    const prefix = `denobase-test-${crypto.randomUUID()}/`;
    try {
      await st.put(`${prefix}small.txt`, text("hello"), { type: "text/plain" });
      const big = bytes(MULTIPART_THRESHOLD + 123);
      await st.put(`${prefix}big.bin`, streamOf([big]), { type: "application/octet-stream" });
      assertEquals((await st.stat(`${prefix}small.txt`))?.type, "text/plain");
      const r = (await st.get(`${prefix}big.bin`, { range: { start: 10, end: 19 } }))!;
      assertEquals([r.size, await readAll(r.body)], [big.byteLength, big.slice(10, 20)]);
      assertEquals((await Array.fromAsync(st.list(prefix))).length, 2);
    } finally {
      await st.deletePrefix(prefix);
    }
    assertEquals((await Array.fromAsync(st.list(prefix))).length, 0);
  },
});
