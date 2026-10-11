import { assert, assertEquals, assertRejects } from "@std/assert";
import { boundaryOf, multipartBody, SpooledFile, spoolMultipart, withSpoolScope } from "./spool.ts";

/** A body split into chunks of n bytes, so delimiters and headers straddle chunk edges. */
function chunked(bytes: Uint8Array, n: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (off >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(off, off + n));
      off += n;
    },
  });
}

async function encoded(form: FormData) {
  const r = new Request("http://x", { method: "POST", body: form });
  return { type: r.headers.get("content-type")!, bytes: new Uint8Array(await r.arrayBuffer()) };
}

Deno.test("spoolMultipart parses fields and files across any chunking", async () => {
  const big = new Uint8Array(70_000).map((_, i) => i % 251);
  const form = new FormData();
  form.append("titulo", "olá\r\n--não é delimitador");
  form.append("anexo", new File([big], "a b.bin", { type: "application/x-test" }));
  form.append("anexo", new File([], "vazio.txt", { type: "text/plain" }));
  const { type, bytes } = await encoded(form);
  for (const n of [1, 7, 4096, bytes.length]) {
    await withSpoolScope(async () => {
      const out = await spoolMultipart(chunked(bytes, n), boundaryOf(type)!, () => 1 << 20);
      assertEquals(out.get("titulo"), "olá\r\n--não é delimitador");
      const [a, b] = out.getAll("anexo") as SpooledFile[];
      assert(a instanceof File);
      assertEquals([a.name, a.type, a.size], ["a b.bin", "application/x-test", big.length]);
      assertEquals(await a.bytes(), big);
      assertEquals(new Uint8Array(await new Response(a.stream()).arrayBuffer()), big);
      assertEquals([b.name, b.size], ["vazio.txt", 0]);
    });
  }
});

Deno.test("a part over its limit reports the size sent but keeps only the limit on disk", async () => {
  const form = new FormData();
  form.append("f", new File([new Uint8Array(5000)], "x.bin"));
  const { type, bytes } = await encoded(form);
  let path = "";
  await withSpoolScope(async () => {
    const f = (await spoolMultipart(chunked(bytes, 333), boundaryOf(type)!, () => 100)).get("f") as SpooledFile;
    path = f.path;
    assertEquals(f.size, 5000);
    assertEquals((await Deno.stat(path)).size, 100);
  });
  // The scope removed the spool dir.
  await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
});

Deno.test("a truncated body is malformed and the scope still cleans up", async () => {
  const form = new FormData();
  form.append("f", new File(["abc"], "x.bin"));
  const { type, bytes } = await encoded(form);
  await withSpoolScope(async () => {
    await assertRejects(() =>
      spoolMultipart(chunked(bytes.slice(0, bytes.length - 10), 5), boundaryOf(type)!, () => 9)
    );
  });
});

Deno.test("multipartBody streams spooled files back as a parsable form", async () => {
  const form = new FormData();
  form.append("f", new File(["conteúdo"], 'a"b.txt', { type: "text/plain" }));
  const { type, bytes } = await encoded(form);
  await withSpoolScope(async () => {
    const spooled = await spoolMultipart(chunked(bytes, 3), boundaryOf(type)!, () => 100);
    const { body, contentType } = multipartBody([["k", "v"], ["f", spooled.get("f") as File]]);
    const back = await new Request("http://x", { method: "POST", headers: { "content-type": contentType }, body })
      .formData();
    assertEquals(back.get("k"), "v");
    const f = back.get("f") as File;
    // Names are kept as sent, escapes included, like Go's multipart reader.
    assertEquals([f.name, f.type, await f.text()], ["a%22b.txt", "text/plain", "conteúdo"]);
  });
});

/** A form of `n` text parts of `size` bytes each, generated as it is read. */
function manyParts(n: number, size: number): { body: ReadableStream<Uint8Array>; boundary: string } {
  const boundary = "b0undary";
  const enc = new TextEncoder();
  const fill = new Uint8Array(size).fill(0x61);
  let i = 0;
  return {
    boundary,
    body: new ReadableStream({
      pull(ctl) {
        if (i === n) {
          ctl.enqueue(enc.encode(`--${boundary}--\r\n`));
          return ctl.close();
        }
        ctl.enqueue(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="f${i++}"\r\n\r\n`));
        ctl.enqueue(fill);
        ctl.enqueue(enc.encode("\r\n"));
      },
    }),
  };
}

Deno.test("text parts are capped together and parts are capped in number, like Go's ReadForm", async () => {
  // Each part is small; together they pass what one form may hold in memory.
  const big = manyParts(50, 1 << 20);
  await assertRejects(() => spoolMultipart(big.body, big.boundary, () => 0), Error, "form text too large");
  const many = manyParts(1001, 1);
  await assertRejects(() => spoolMultipart(many.body, many.boundary, () => 0), Error, "too many parts");
  const ok = manyParts(1000, 1);
  assertEquals([...(await spoolMultipart(ok.body, ok.boundary, () => 0)).keys()].length, 1000);
});
