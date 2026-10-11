import { assert, assertEquals } from "@std/assert";
import { serveContent } from "./serve_content.ts";

Deno.test("multipart/byteranges reads at the client's pace and stops when the client goes away", async () => {
  const size = 64 << 20;
  let pulled = 0;
  let canceled = 0;
  const open = () =>
    Promise.resolve(
      new ReadableStream<Uint8Array>({
        pull(ctl) {
          pulled++;
          ctl.enqueue(new Uint8Array(64 << 10));
        },
        cancel() {
          canceled++;
        },
      }, { highWaterMark: 0 }),
    );
  const res = await serveContent({
    request: new Request("http://x/f", { headers: { Range: "bytes=0-0,1-" } }),
    info: { key: "f", size, type: "video/mp4", modified: new Date() },
    headers: new Headers({ "Content-Type": "video/mp4" }),
    open,
  });
  assertEquals(res.status, 206);
  const reader = res.body!.getReader();
  for (let i = 0; i < 4; i++) await reader.read();
  await new Promise((r) => setTimeout(r, 20));
  // Nothing ran ahead of the reads: a 64 MiB span is not buffered for a client that read four chunks.
  assert(pulled <= 4, `pulled ${pulled} chunks ahead of the client`);
  await reader.cancel();
  assertEquals(canceled, 1);
});
