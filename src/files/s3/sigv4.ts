/**
 * AWS Signature Version 4 for S3, on WebCrypto. Shared by the client (signs) and the fake server (verifies), and
 * pinned to AWS's published example in the tests so the two cannot drift together.
 */

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 unreserved stays, everything else is %XX: what S3 expects (encodeURIComponent leaves !'()* alone). */
export function uriEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replaceAll("%2F", "/") : out;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED = "UNSIGNED-PAYLOAD";

export interface SignInput {
  method: string;
  /** Already encoded path, as sent on the wire. */
  path: string;
  /** Decoded query pairs. */
  query: [string, string][];
  /** Lowercase names; host included. Every header here is signed. */
  headers: Record<string, string>;
  payloadHash: string;
  /** yyyymmddThhmmssZ */
  amzDate: string;
  region: string;
  accessKey: string;
  secret: string;
}

export function canonicalQuery(query: [string, string][]): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** The Authorization header value for in. */
export async function signature(input: SignInput): Promise<{ authorization: string; signature: string }> {
  const names = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) lower[k.toLowerCase()] = v;
  const signed = names.join(";");
  const canonical = [
    input.method,
    input.path || "/",
    canonicalQuery(input.query),
    names.map((n) => `${n}:${lower[n].trim().replace(/\s+/g, " ")}\n`).join(""),
    signed,
    input.payloadHash,
  ].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, await sha256Hex(canonical)].join("\n");
  let key = await hmac(enc.encode(`AWS4${input.secret}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const sig = hex(await hmac(key, toSign));
  return {
    signature: sig,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

export function amzDate(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
