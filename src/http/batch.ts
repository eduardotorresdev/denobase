import type { Context, Hono } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { ApiError, badRequest, forbidden } from "../core/errors.ts";
import { tx } from "../core/db.ts";
import { getCollection } from "../core/registry.ts";
import { findOne } from "../store/sqlite.ts";
import { formEntries, JSON_PAYLOAD, uploadLimit } from "./form.ts";
import { allFields } from "../engine/fields.ts";
import { boundaryOf, multipartBody, spoolMultipart } from "../files/spool.ts";

/** PB core.InternalRequest. */
interface InternalRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Uploads sent as multipart "requests.<i>.<field>", PB's batch file fields. */
  files?: Map<string, File[]>;
}

/** PB apis.ValidBatchActions: only record writes may be batched. */
const ACTIONS: { re: RegExp; method: string }[] = [
  { re: /^PUT \/api\/collections\/(?<collection>[^/?]+)\/records(?<query>\?.*)?$/, method: "PUT" },
  { re: /^POST \/api\/collections\/(?<collection>[^/?]+)\/records(\?.*)?$/, method: "POST" },
  { re: /^PATCH \/api\/collections\/(?<collection>[^/?]+)\/records\/(?<id>[^/?]+)(\?.*)?$/, method: "PATCH" },
  { re: /^DELETE \/api\/collections\/(?<collection>[^/?]+)\/records\/(?<id>[^/?]+)(\?.*)?$/, method: "DELETE" },
];

/** A failed sub-request: rolls the batch back and carries the sub-response PB nests under requests.<i>. */
class SubRequestFailed extends Error {
  constructor(readonly index: number, readonly response: ApiError) {
    super("Batch request failed.");
  }
}

/** POST /api/batch, PB batch: every request in one transaction, all or nothing. */
export function batchRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.post("/api/batch", async (c) => {
    const cfg = ctx.settings.batch;
    if (!cfg.enabled || cfg.maxRequests <= 0) throw forbidden("Batch requests are not allowed.");
    let form: { requests?: unknown };
    try {
      form = await readBatch(c, ctx);
    } catch {
      throw badRequest("Failed to read the submitted batch data.");
    }
    const requests = form?.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      throw badRequest("Invalid batch request data.", {
        requests: { code: "validation_required", message: "Cannot be blank." },
      });
    }
    if (requests.length > cfg.maxRequests) {
      throw badRequest("Invalid batch request data.", {
        requests: {
          code: "validation_length_too_long",
          message: `The length must be no more than ${cfg.maxRequests}.`,
        },
      });
    }
    try {
      const results = await withTimeout(tx(ctx.db, () => run(app, c, ctx, requests as InternalRequest[])), cfg.timeout);
      return c.json(results);
    } catch (e) {
      if (!(e instanceof SubRequestFailed)) throw badRequest("Batch transaction failed.");
      throw badRequest(
        "Batch transaction failed.",
        {
          requests: {
            [String(e.index)]: {
              code: "batch_request_failed",
              message: "Batch request failed.",
              response: e.response.toJSON(),
            },
          },
        } as unknown as ApiError["data"],
      );
    }
  });
}

/** Sub-requests go through the app's own routes, nested in the batch tx, so every write is a savepoint of it. */
async function run(app: Hono<AppEnv>, c: Context<AppEnv>, ctx: Ctx, requests: InternalRequest[]) {
  const results: { body: unknown; status: number }[] = [];
  for (const [i, r] of requests.entries()) {
    const action = resolve(ctx, r);
    if (!action) throw new SubRequestFailed(i, badRequest());
    const headers = new Headers(c.req.raw.headers);
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      // The batch's own auth applies to every sub-request; per-request Authorization is ignored, like PB.
      if (k.toLowerCase() !== "authorization") headers.set(k, String(v));
    }
    let payload: BodyInit | undefined;
    if (action.method === "DELETE") payload = undefined;
    else if (r.files?.size) {
      // PB re-encodes a sub-request with files as multipart: regular fields under @jsonPayload, files as parts.
      // Built by hand so spooled uploads stream from disk into the sub-request.
      const parts: [string, string | File][] = [[JSON_PAYLOAD, JSON.stringify(r.body ?? {})]];
      for (const [k, files] of r.files) for (const f of files) parts.push([k, f]);
      const multipart = multipartBody(parts);
      headers.set("content-type", multipart.contentType);
      payload = multipart.body;
    } else {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(r.body ?? {});
    }
    // The sub-request's own server span (tracing middleware) is the item's span: no extra wrapper per item.
    const res = await app.request(action.url, { method: action.method, headers, body: payload }, c.env);
    const body = res.status === 204 ? null : await res.json();
    if (res.status >= 400) {
      throw new SubRequestFailed(i, new ApiError(res.status, body?.message ?? "", body?.data ?? {}));
    }
    results.push({ body, status: res.status });
  }
  return results;
}

/** JSON body, or multipart with the requests in @jsonPayload and files keyed "requests.<i>.<field>". */
async function readBatch(c: Context<AppEnv>, ctx: Ctx): Promise<{ requests?: unknown }> {
  const boundary = boundaryOf(c.req.header("content-type") ?? "");
  if (!boundary) return await c.req.json();
  // Parts may come before the @jsonPayload that says which collection they target: keep up to the largest limit of
  // any file field, one byte more so an oversize part stays oversize, and let the sub-request apply the exact one.
  const max = Math.max(0, ...ctx.collections.flatMap((col) => allFields(col).map(uploadLimit))) + 1;
  const entries = formEntries(await spoolMultipart(c.req.raw.body, boundary, () => max));
  const form = JSON.parse(String(entries.get(JSON_PAYLOAD)?.[0] ?? "{}")) as { requests?: unknown };
  if (!Array.isArray(form.requests)) return form;
  for (const [key, values] of entries) {
    const m = key.match(/^requests\.(\d+)\.(.+)$/);
    const r = m && (form.requests[Number(m[1])] as InternalRequest | undefined);
    if (!r || typeof r !== "object") continue;
    const files = values.filter((v): v is File => v instanceof File);
    if (!files.length) continue;
    r.files ??= new Map();
    r.files.set(m![2], [...(r.files.get(m![2]) ?? []), ...files]);
  }
  return form;
}

/** PUT upserts: an existing body.id updates (PATCH), anything else creates (POST) keeping that id. */
function resolve(ctx: Ctx, r: InternalRequest): { method: string; url: string } | null {
  if (!r || typeof r.method !== "string" || typeof r.url !== "string") return null;
  const full = `${r.method.toUpperCase()} ${r.url}`;
  for (const a of ACTIONS) {
    const m = full.match(a.re);
    if (!m) continue;
    if (a.method !== "PUT") return { method: a.method, url: r.url };
    const id = typeof r.body?.id === "string" ? r.body.id : "";
    const { collection, query = "" } = m.groups!;
    let exists = false;
    try {
      exists = !!id && !!findOne(ctx.db, getCollection(collection, ctx.collections), id);
    } catch { /* unknown collection: the POST answers its 404 */ }
    return exists
      ? { method: "PATCH", url: `/api/collections/${collection}/records/${id}${query}` }
      : { method: "POST", url: `/api/collections/${collection}/records${query}` };
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("batch transaction timeout")), (seconds > 0 ? seconds : 3) * 1000);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}
