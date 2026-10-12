/**
 * A small S3 client on fetch: just the calls a BlobStore needs, signed with SigV4. Own code instead of the AWS SDK
 * because JSR consumers get no npm postinstall and the SDK would dwarf the rest of the package.
 */
import { createHash } from "node:crypto";
import type { S3Config } from "../../settings/model.ts";
import { amzDate, sha256Hex, signature, UNSIGNED, uriEncode } from "./sigv4.ts";

export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`S3 ${status} ${code}: ${message}`);
    this.name = "S3Error";
  }
}

export interface S3Request {
  method: string;
  /** Object key; empty for bucket-level calls. */
  key?: string;
  query?: [string, string][];
  headers?: Record<string, string>;
  /** Bodies are always buffered parts (at most a multipart chunk), so their length and hash are known. */
  body?: Uint8Array;
  /** Hash the body into the signature (small XML bodies); parts go UNSIGNED-PAYLOAD to avoid a second pass. */
  signBody?: boolean;
}

function xmlText(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "amp") return "&";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** Text of every <tag> directly found in xml, in order; S3's answers are flat enough for this. */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => xmlText(m[1]));
}

export function xmlOne(xml: string, tag: string): string | undefined {
  return xmlAll(xml, tag)[0];
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export class S3Client {
  readonly #base: URL;
  readonly #pathStyle: boolean;

  constructor(readonly cfg: S3Config, readonly fetcher: typeof fetch = fetch) {
    const endpoint = cfg.endpoint.trim() || `https://s3.${cfg.region || "us-east-1"}.amazonaws.com`;
    // PB accepts an endpoint without scheme ("s3.example.com"); https is what it means.
    this.#base = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
    this.#pathStyle = cfg.forcePathStyle;
  }

  #url(key: string, query: [string, string][]): URL {
    const u = new URL(this.#base);
    const basePath = u.pathname.replace(/\/$/, "");
    const k = key ? `/${uriEncode(key, true)}` : "/";
    if (this.#pathStyle) u.pathname = `${basePath}/${uriEncode(this.cfg.bucket)}${key ? k : ""}`;
    else {
      u.hostname = `${this.cfg.bucket}.${u.hostname}`;
      u.pathname = `${basePath}${k}`;
    }
    u.search = query.map(([a, b]) => (b === "" ? uriEncode(a) : `${uriEncode(a)}=${uriEncode(b)}`)).join("&");
    return u;
  }

  /** Sends a signed request; a non-2xx answer becomes an S3Error unless allowed lists it. */
  async send(req: S3Request, allowed: number[] = []): Promise<Response> {
    const query = req.query ?? [];
    const url = this.#url(req.key ?? "", query);
    const date = amzDate();
    const payloadHash = req.body && req.signBody ? await sha256Hex(req.body) : UNSIGNED;
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      host: url.host,
      "x-amz-date": date,
      "x-amz-content-sha256": payloadHash,
    };
    const { authorization } = await signature({
      method: req.method,
      // URL normalizes the path the way fetch will put it on the wire.
      path: url.pathname,
      query,
      headers,
      payloadHash,
      amzDate: date,
      region: this.cfg.region || "us-east-1",
      accessKey: this.cfg.accessKey,
      secret: this.cfg.secret,
    });
    const { host: _host, ...sent } = headers;
    const res = await this.fetcher(url, {
      method: req.method,
      headers: { ...sent, authorization },
      body: req.body as Uint8Array<ArrayBuffer> | undefined,
    });
    if (res.ok || allowed.includes(res.status)) return res;
    const text = req.method === "HEAD" ? "" : await res.text().catch(() => "");
    throw new S3Error(
      res.status,
      xmlOne(text, "Code") ?? (res.status === 404 ? "NotFound" : res.statusText || "Error"),
      xmlOne(text, "Message") ?? (text.slice(0, 200) || res.statusText),
    );
  }
}

/** Content-MD5 for DeleteObjects, which S3 refuses without one; WebCrypto has no MD5. */
export function md5Base64(body: Uint8Array): string {
  return createHash("md5").update(body).digest("base64");
}
