import { encodeHex } from "@std/encoding/hex";

/**
 * Canonical JSON (§17): keys sorted, bytes as `{"$bytes": <sha256>}`, Date as ISO, undefined dropped. Two calls with
 * the same arguments hash the same whatever the key order the caller built them in; media hashes by content.
 */
export async function canonical(v: unknown): Promise<string> {
  if (v === undefined || v === null) return "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    return `{"$bytes":${JSON.stringify(await sha256(bytes))}}`;
  }
  if (Array.isArray(v)) return `[${(await Promise.all(v.map((x) => canonical(x ?? null)))).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = await Promise.all(entries.map(async ([k, x]) => `${JSON.stringify(k)}:${await canonical(x)}`));
    return `{${parts.join(",")}}`;
  }
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  return JSON.stringify(v);
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

/** The hash part of a service call's idempotency key: method and arguments. */
export async function callHash(service: string, method: string, args: unknown[]): Promise<string> {
  return (await sha256(`${service}.${method}:${await canonical(args)}`)).slice(0, 32);
}
