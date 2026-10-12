import type { BlobInfo, BlobRange } from "../files/storage.ts";

/**
 * Go's http.ServeContent, which PB's filesystem.Serve hands every file to: Last-Modified, conditional
 * requests (If-Match/If-Unmodified-Since/If-None-Match/If-Modified-Since/If-Range), single and multipart
 * byte ranges, 206/304/412/416 with Go's bodies. PB sets no ETag, so neither do we.
 */

interface ByteRange {
  start: number;
  length: number;
}

const httpDate = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000).toUTCString();

/** Go compares at second precision and ignores a zero (unknown) mod time. */
function modSeconds(d: Date): number | null {
  const t = d.getTime();
  return t <= 0 || Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function parseHttpDate(v: string): number | null {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

type Cond = "none" | "true" | "false";

/** No ETag is ever set, so only "*" can match (Go's etagStrongMatch/etagWeakMatch against ""). */
function ifMatch(v: string | null): Cond {
  if (v === null || v === "") return "none";
  return v.split(",").some((t) => t.trim() === "*") ? "true" : "false";
}

function ifNoneMatch(v: string | null): Cond {
  if (v === null || v === "") return "none";
  return v.split(",").some((t) => t.trim() === "*") ? "false" : "true";
}

/** Go's parseRange: null for "no ranges", "invalid"/"nooverlap" for the 416 cases. */
export function parseRange(s: string | null, size: number): ByteRange[] | "invalid" | "nooverlap" | null {
  if (!s) return null;
  const b = "bytes=";
  if (!s.startsWith(b)) return "invalid";
  const out: ByteRange[] = [];
  let noOverlap = false;
  const num = (t: string) => (/^\d+$/.test(t) ? Number(t) : NaN);
  for (const raw of s.slice(b.length).split(",")) {
    const ra = raw.trim();
    if (!ra) continue;
    const dash = ra.indexOf("-");
    if (dash < 0) return "invalid";
    const start = ra.slice(0, dash).trim();
    const end = ra.slice(dash + 1).trim();
    if (start === "") {
      if (end === "" || end.startsWith("-")) return "invalid";
      let i = num(end);
      if (Number.isNaN(i)) return "invalid";
      if (i > size) i = size;
      out.push({ start: size - i, length: i });
    } else {
      const i = num(start);
      if (Number.isNaN(i)) return "invalid";
      if (i >= size) {
        // Valid syntax, just past the end: skipped, and a 416 only if nothing else overlaps.
        noOverlap = true;
        continue;
      }
      if (end === "") {
        out.push({ start: i, length: size - i });
      } else {
        let j = num(end);
        if (Number.isNaN(j) || i > j) return "invalid";
        if (j >= size) j = size - 1;
        out.push({ start: i, length: j - i + 1 });
      }
    }
  }
  if (noOverlap && out.length === 0) return "nooverlap";
  return out;
}

function goError(status: number, text: string, headers: Headers): Response {
  // Go's serveError drops the caching validators before http.Error writes the plain text body.
  for (const h of ["Cache-Control", "Content-Encoding", "ETag", "Last-Modified", "Content-Length"]) headers.delete(h);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(text + "\n", { status, headers });
}

function randomBoundary(): string {
  const b = crypto.getRandomValues(new Uint8Array(30));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface ServeContentOptions {
  request: Request;
  info: BlobInfo;
  /** Headers already chosen by the caller (Content-Type, Content-Disposition, ...). */
  headers: Headers;
  open: (range?: BlobRange) => Promise<ReadableStream<Uint8Array> | null>;
}

export async function serveContent(o: ServeContentOptions): Promise<Response> {
  const { request: req, info, headers } = o;
  const size = info.size;
  const mod = modSeconds(info.modified);
  const method = req.method.toUpperCase();
  const isGetHead = method === "GET" || method === "HEAD";
  if (mod !== null) headers.set("Last-Modified", httpDate(info.modified));

  // checkPreconditions, in Go's order.
  let ch = ifMatch(req.headers.get("If-Match"));
  if (ch === "none") {
    const ius = req.headers.get("If-Unmodified-Since");
    const t = ius ? parseHttpDate(ius) : null;
    if (ius && t !== null && mod !== null) ch = mod <= t ? "true" : "false";
  }
  if (ch === "false") return new Response(null, { status: 412, headers });
  let rangeHeader = req.headers.get("Range");
  const inm = ifNoneMatch(req.headers.get("If-None-Match"));
  const notModified = () => {
    for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) headers.delete(h);
    return new Response(null, { status: 304, headers });
  };
  if (inm === "false") {
    if (isGetHead) return notModified();
    return new Response(null, { status: 412, headers });
  }
  if (inm === "none" && isGetHead) {
    const ims = req.headers.get("If-Modified-Since");
    const t = ims ? parseHttpDate(ims) : null;
    if (ims && t !== null && mod !== null && mod <= t) return notModified();
  }
  if (rangeHeader && isGetHead) {
    const ir = req.headers.get("If-Range");
    if (ir) {
      // Only a date can match, since there is no ETag; anything else drops the range.
      const t = ir.startsWith('"') || ir.startsWith("W/") ? null : parseHttpDate(ir);
      if (t === null || mod === null || mod !== t) rangeHeader = null;
    }
  } else if (!isGetHead) rangeHeader = null;

  const parsed = parseRange(rangeHeader, size);
  if (parsed === "invalid" || parsed === "nooverlap") {
    headers.set("Content-Range", `bytes */${size}`);
    return goError(416, parsed === "invalid" ? "invalid range" : "invalid range: failed to overlap", headers);
  }
  let ranges = parsed ?? [];
  // A client asking for more than the file (overlaps) gets the whole file, as Go does.
  if (ranges.reduce((n, r) => n + r.length, 0) > size) ranges = [];

  headers.set("Accept-Ranges", "bytes");
  const ctype = headers.get("Content-Type") ?? "application/octet-stream";
  const head = method === "HEAD";
  const body = async (r?: BlobRange) => {
    if (head) return null;
    const s = await o.open(r);
    if (!s) throw new Error("storage: blob vanished while serving");
    return s;
  };

  if (ranges.length === 0) {
    headers.set("Content-Length", String(size));
    return new Response(await body(), { status: 200, headers });
  }
  if (ranges.length === 1) {
    const r = ranges[0];
    headers.set("Content-Range", `bytes ${r.start}-${r.start + r.length - 1}/${size}`);
    headers.set("Content-Length", String(r.length));
    return new Response(await body({ start: r.start, end: r.start + r.length - 1 }), { status: 206, headers });
  }

  // multipart/byteranges, byte for byte what Go's mime/multipart writer emits.
  const boundary = randomBoundary();
  const enc = new TextEncoder();
  const parts = ranges.map((r, i) =>
    enc.encode(
      `${i ? "\r\n" : ""}--${boundary}\r\nContent-Range: bytes ${r.start}-${
        r.start + r.length - 1
      }/${size}\r\nContent-Type: ${ctype}\r\n\r\n`,
    )
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const total = parts.reduce((n, p, i) => n + p.byteLength + ranges[i].length, 0) + tail.byteLength;
  headers.set("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  headers.set("Content-Length", String(total));
  if (head) return new Response(null, { status: 206, headers });
  // Pull-driven, one range open at a time: the client's pace bounds what is read, and a disconnect stops it.
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (reader) {
        const r = await reader.read();
        if (!r.done) return ctl.enqueue(r.value);
        reader = null;
        i++;
      }
      if (i < ranges.length) {
        const r = ranges[i];
        reader = (await body({ start: r.start, end: r.start + r.length - 1 }))!.getReader();
        return ctl.enqueue(parts[i]);
      }
      if (!done) {
        done = true;
        ctl.enqueue(tail);
      }
      ctl.close();
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => {});
      reader = null;
    },
  }, { highWaterMark: 0 });
  return new Response(stream, { status: 206, headers });
}
