import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

/**
 * Payloads, results and service arguments cross processes as JSON in _jobs: bytes travel as {"$b64": ...} and come
 * back as Uint8Array, dates as {"$date": iso}. Everything else must already be JSON.
 */
export function toWire(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Uint8Array) return { $b64: encodeBase64(v) };
  if (v instanceof ArrayBuffer) return { $b64: encodeBase64(new Uint8Array(v)) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
    return out;
  }
  return v;
}

export function fromWire(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromWire);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$b64 === "string") return decodeBase64(o.$b64);
    if (keys.length === 1 && typeof o.$date === "string") return new Date(o.$date);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = fromWire(x);
    return out;
  }
  return v;
}

/** An error as it is kept in _jobs and rethrown on the other side: an ApiError keeps its status and stable code. */
export interface WireError {
  message: string;
  status?: number;
  code?: string;
  data?: unknown;
  name?: string;
}

export function errorToWire(e: unknown): WireError {
  if (e instanceof Error) {
    const x = e as Error & { status?: number; code?: string; data?: unknown };
    return {
      message: e.message,
      name: e.name,
      status: typeof x.status === "number" ? x.status : undefined,
      code: typeof x.code === "string" ? x.code : undefined,
      data: x.data,
    };
  }
  return { message: String(e) };
}
