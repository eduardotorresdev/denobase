import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Multipart uploads spooled to disk instead of `Request.formData()`, which holds every part in memory. A file part
 * streams into a temp file of the request's spool dir, and becomes a SpooledFile: a File whose bytes are read back
 * from disk. Past the part's limit the bytes are counted and dropped, so an oversize upload still reports its real
 * size to validation (PB's validation_file_size_limit) without the disk taking it. The dir goes when the request
 * scope ends, whatever the outcome (stored, validation error, rollback).
 */

/** A File backed by a temp file; size is the size sent, even when the part was cut at its limit. */
export class SpooledFile extends File {
  readonly #path: string;
  readonly #size: number;

  constructor(path: string, size: number, name: string, type: string) {
    super([], name, { type });
    this.#path = path;
    this.#size = size;
  }

  override get size(): number {
    return this.#size;
  }

  /** Path of the bytes on disk; only the first `limit` bytes when the part went over it. */
  get path(): string {
    return this.#path;
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let file: Deno.FsFile | undefined;
    const path = this.#path;
    return new ReadableStream({
      type: "bytes",
      async pull(ctrl) {
        file ??= await Deno.open(path, { read: true });
        const buf = new Uint8Array(64 << 10);
        const n = await file.read(buf);
        if (n === null) {
          file.close();
          ctrl.close();
          return;
        }
        ctrl.enqueue(buf.subarray(0, n));
      },
      cancel() {
        file?.close();
      },
    });
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return (await Deno.readFile(this.#path)).buffer as ArrayBuffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return await Deno.readFile(this.#path) as Uint8Array<ArrayBuffer>;
  }

  override async text(): Promise<string> {
    return await Deno.readTextFile(this.#path);
  }
}

/** Spool dirs made under the current scope, removed when it ends. */
const scope = new AsyncLocalStorage<string[]>();

/** Runs fn with an upload scope: every spool dir made inside it is removed once fn settles. */
export async function withSpoolScope<T>(fn: () => Promise<T>): Promise<T> {
  const dirs: string[] = [];
  try {
    return await scope.run(dirs, fn);
  } finally {
    await Promise.all(dirs.map((d) => Deno.remove(d, { recursive: true }).catch(() => {})));
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Text parts stay in memory; above this a form is not a form (Go's multipart caps the non-file part too). */
const MAX_TEXT = 32 << 20;

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A Content-Disposition parameter; quoted values unescape \" and \\ like Go's mime.ParseMediaType. */
function param(header: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, "i");
  const m = header.match(re);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2].trim();
}

function headersOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

/** The multipart boundary of a content type, or null when it is not multipart/form-data. */
export function boundaryOf(contentType: string): string | null {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;
  return param(contentType.slice(contentType.indexOf(";") + 1), "boundary") ?? null;
}

/**
 * Parses a multipart/form-data body as it streams in. limit(key) is how many bytes of a file part under that key are
 * kept on disk; the rest is counted only. Throws on a malformed body.
 */
export async function spoolMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  limit: (key: string) => number,
): Promise<FormData> {
  const form = new FormData();
  if (!body) return form;
  // The leading CRLF lets the first delimiter match like every later one, preamble or not.
  const delim = enc.encode(`\r\n--${boundary}`);
  let buf: Uint8Array = enc.encode("\r\n");
  // Widened on purpose: the parse loop changes it from awaits TS cannot follow.
  let state = "preamble" as "preamble" | "afterDelim" | "headers" | "body" | "done";
  let part: {
    key: string;
    file?: { fh: Deno.FsFile; path: string; name: string; type: string; size: number; max: number };
    text?: Uint8Array[];
    textLen: number;
  } | null = null;
  let dir: string | undefined;
  let seq = 0;

  const write = async (chunk: Uint8Array) => {
    if (!part || !chunk.length) return;
    const f = part.file;
    if (f) {
      const room = f.max - f.size;
      if (room > 0) {
        const keep = chunk.length > room ? chunk.subarray(0, room) : chunk;
        for (let off = 0; off < keep.length;) off += await f.fh.write(keep.subarray(off));
      }
      f.size += chunk.length;
      return;
    }
    part.textLen += chunk.length;
    if (part.textLen > MAX_TEXT) throw new Error("multipart: text part too large");
    part.text!.push(chunk.slice());
  };

  const finish = () => {
    if (!part) return;
    if (part.file) {
      const f = part.file;
      f.fh.close();
      form.append(part.key, new SpooledFile(f.path, f.size, f.name, f.type));
    } else {
      const all = new Uint8Array(part.textLen);
      let off = 0;
      for (const c of part.text!) all.set(c, off), off += c.length;
      form.append(part.key, dec.decode(all));
    }
    part = null;
  };

  const reader = body.getReader();
  try {
    let eof = false;
    while (state !== "done") {
      let progressed = true;
      while (progressed && state !== "done") {
        progressed = false;
        if (state === "preamble" || state === "body") {
          const i = indexOf(buf, delim);
          if (i >= 0) {
            if (state === "body") await write(buf.subarray(0, i)), finish();
            buf = buf.subarray(i + delim.length);
            state = "afterDelim";
            progressed = true;
          } else if (buf.length >= delim.length) {
            // Keep a tail that could be the start of a delimiter split across chunks.
            const cut = buf.length - delim.length + 1;
            if (state === "body") await write(buf.subarray(0, cut));
            buf = buf.subarray(cut);
          }
        } else if (state === "afterDelim") {
          if (buf.length < 2) break;
          if (buf[0] === 0x2d && buf[1] === 0x2d) state = "done";
          else {
            // Transport padding after the boundary, then the CRLF.
            const nl = indexOf(buf, enc.encode("\r\n"));
            if (nl < 0) break;
            buf = buf.subarray(nl + 2);
            state = "headers";
            progressed = true;
          }
        } else if (state === "headers") {
          const end = indexOf(buf, enc.encode("\r\n\r\n"));
          // A part with no headers at all starts its body right away.
          const empty = buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a;
          if (end < 0 && !empty) {
            if (buf.length > 64 << 10) throw new Error("multipart: headers too large");
            break;
          }
          const h = headersOf(empty ? "" : dec.decode(buf.subarray(0, end)));
          buf = buf.subarray(empty ? 2 : end + 4);
          const disp = h.get("content-disposition") ?? "";
          const key = param(disp, "name") ?? "";
          const filename = param(disp, "filename");
          if (filename !== undefined) {
            dir ??= await makeDir();
            const path = `${dir}/${seq++}`;
            const fh = await Deno.open(path, { write: true, createNew: true });
            const type = h.get("content-type") || "application/octet-stream";
            part = { key, textLen: 0, file: { fh, path, name: filename, type, size: 0, max: Math.max(0, limit(key)) } };
          } else part = { key, text: [], textLen: 0 };
          state = "body";
          progressed = true;
        }
      }
      if (state === "done") break;
      if (eof) throw new Error("multipart: unexpected end of body");
      const r = await reader.read();
      if (r.done) eof = true;
      else buf = concat(buf, r.value);
    }
  } catch (e) {
    (part as { file?: { fh: Deno.FsFile } } | null)?.file?.fh.close();
    throw e;
  } finally {
    reader.releaseLock();
  }
  return form;
}

async function makeDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denobase-upload-" });
  const dirs = scope.getStore();
  if (dirs) dirs.push(dir);
  // Outside a scope nobody would remove it: drop it when the process exits at the latest.
  else globalThis.addEventListener("unload", () => void Deno.removeSync(dir, { recursive: true }));
  return dir;
}

/**
 * A multipart body for files and fields, streamed from disk: re-encoding SpooledFiles through FormData would read
 * their (empty) in-memory parts. Used by the batch sub-requests.
 */
export function multipartBody(
  fields: [string, string | File][],
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = `denobase${crypto.randomUUID().replaceAll("-", "")}`;
  // WHATWG's multipart/form-data escaping, what FormData itself would send.
  const esc = (s: string) => s.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
  const it = fields[Symbol.iterator]();
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (current) {
        const r = await current.read();
        if (!r.done) return ctrl.enqueue(r.value);
        current = null;
        return ctrl.enqueue(enc.encode("\r\n"));
      }
      if (ended) return ctrl.close();
      const n = it.next();
      if (n.done) {
        ended = true;
        return ctrl.enqueue(enc.encode(`--${boundary}--\r\n`));
      }
      const [k, v] = n.value;
      if (typeof v === "string") {
        return ctrl.enqueue(
          enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v}\r\n`),
        );
      }
      current = v.stream().getReader();
      ctrl.enqueue(enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"; filename="${esc(v.name)}"\r\n` +
          `Content-Type: ${v.type || "application/octet-stream"}\r\n\r\n`,
      ));
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
