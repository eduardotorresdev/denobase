/// <reference lib="deno.worker" />
/**
 * A thumb pool thread: decodes, resizes and encodes one image per message, so a large decode never blocks the main
 * thread's event loop. The original arrives and the thumb leaves as transferred buffers, never copied.
 */
import { renderThumb } from "./thumbs.ts";
import type { ThumbJob, ThumbResult } from "./thumb_pool.ts";

self.onmessage = async (e: MessageEvent<ThumbJob>) => {
  const { id, bytes, type, size } = e.data;
  try {
    const out = await renderThumb(bytes, type, size);
    // A fresh buffer per thumb: the transfer detaches it and leaves nothing else behind.
    const own = out.bytes.byteOffset === 0 && out.bytes.byteLength === out.bytes.buffer.byteLength
      ? out.bytes
      : out.bytes.slice();
    self.postMessage({ id, ok: true, bytes: own, type: out.type } satisfies ThumbResult, [own.buffer as ArrayBuffer]);
  } catch (err) {
    self.postMessage(
      { id, ok: false, message: err instanceof Error ? err.message : String(err) } satisfies ThumbResult,
    );
  }
};
