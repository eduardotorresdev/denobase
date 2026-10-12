import { assertEquals } from "@std/assert";
import { type BlobStore, FsStorage, MemoryStorage, readAll } from "./storage.ts";

const enc = new TextEncoder();
const text = async (s: ReadableStream<Uint8Array>) => new TextDecoder().decode(await readAll(s));

async function contract(store: BlobStore) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("hello "));
      c.enqueue(enc.encode("world"));
      c.close();
    },
  });
  await store.put("c1/r1/a.txt", body, { type: "text/plain" });
  await store.put("c1/r2/b.bin", enc.encode("xyz"), { type: "" });
  await store.put("c2/r1/c.txt", enc.encode("c"), { type: "text/plain" });

  const st = (await store.stat("c1/r1/a.txt"))!;
  assertEquals([st.size, st.type, st.modified instanceof Date], [11, "text/plain", true]);
  assertEquals(await store.stat("c1/r1/none"), null);
  assertEquals(await store.get("c1/r1/none"), null);

  const full = (await store.get("c1/r1/a.txt"))!;
  assertEquals([await text(full.body), full.size], ["hello world", 11]);
  const part = (await store.get("c1/r1/a.txt", { range: { start: 6, end: 8 } }))!;
  assertEquals([await text(part.body), part.size], ["wor", 11]);
  const open = (await store.get("c1/r1/a.txt", { range: { start: 6 } }))!;
  assertEquals(await text(open.body), "world");

  const keys = async (p: string) => (await Array.fromAsync(store.list(p))).map((i) => i.key).sort();
  assertEquals(await keys("c1/"), ["c1/r1/a.txt", "c1/r2/b.bin"]);
  assertEquals(await keys(""), ["c1/r1/a.txt", "c1/r2/b.bin", "c2/r1/c.txt"]);
  assertEquals(await keys("c1/r"), ["c1/r1/a.txt", "c1/r2/b.bin"]);

  await store.delete("c1/r2/b.bin");
  await store.deletePrefix("c2/r1/");
  assertEquals(await keys(""), ["c1/r1/a.txt"]);
}

Deno.test("MemoryStorage keeps the BlobStore contract", () => contract(new MemoryStorage()));

Deno.test("FsStorage keeps the BlobStore contract and PB's .attrs sidecar", async () => {
  const root = await Deno.makeTempDir();
  try {
    await contract(new FsStorage(root));
    // A file written by PB itself (data plus sidecar) reads back with its type.
    await Deno.mkdir(`${root}/pb/r`, { recursive: true });
    await Deno.writeTextFile(`${root}/pb/r/x.png`, "png");
    await Deno.writeTextFile(`${root}/pb/r/x.png.attrs`, JSON.stringify({ type: "image/png" }));
    const fs = new FsStorage(root);
    assertEquals((await fs.stat("pb/r/x.png"))?.type, "image/png");
    assertEquals(JSON.parse(await Deno.readTextFile(`${root}/c1/r1/a.txt.attrs`)).type, "text/plain");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
