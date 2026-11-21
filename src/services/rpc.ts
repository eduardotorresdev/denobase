import { ApiError, type ErrorData } from "../core/errors.ts";
import { errorToWire, fromWire, toWire, type WireError } from "./wire.ts";

/**
 * The direct channel between processes (§18): the serve that runs services listens on a Unix socket inside pb_data
 * (no port, no token: the file's permission is the access, as for data.db itself); a caller finds the node in
 * _services and calls it. HTTP over the socket: one request per call, the caller's deadline is its abort, the trace
 * goes in `traceparent`. Nothing is kept: no retry, no request row.
 */

export interface CallRequest {
  service: string;
  method: string;
  args: unknown;
  /** The content key of the call (§16 N4), handed to the service: deduplicating is the service's own. */
  idem: string | null;
}

export type CallAnswer = { ok: true; result: unknown } | { ok: false; error: WireError };

export const svcError = (status: number, code: string, message: string, data: ErrorData = {}) =>
  new ApiError(status, message, data, code);

/** Serves the calls on `path`; `run` is the provider's own function call. */
export function serveCalls(
  path: string,
  run: (r: CallRequest, traceparent: string | null) => Promise<unknown>,
): { close(): Promise<void> } {
  try {
    Deno.removeSync(path); // a socket left by a process that died
  } catch { /* none */ }
  // Only this user may call (data.db's own owner): the socket is 0600 from the moment it is bound.
  const server = Deno.serve({ path, onListen: () => Deno.chmodSync(path, 0o600) }, async (req) => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/call") return new Response(null, { status: 404 });
    let answer: CallAnswer;
    try {
      const r = await req.json() as CallRequest;
      answer = { ok: true, result: toWire(await run(r, req.headers.get("traceparent"))) };
    } catch (e) {
      answer = { ok: false, error: errorToWire(e) };
    }
    return Response.json(answer);
  });
  return {
    close: async () => {
      await server.shutdown().catch(() => {});
      try {
        Deno.removeSync(path);
        // A private temp dir made for a path too long for pb_data (socket.ts): it goes with its socket.
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (/\/dnb-[^/]+$/.test(parent)) Deno.removeSync(parent);
      } catch { /* gone */ }
    },
  };
}

/**
 * A client of its own per call, closed after it: a pooled connection the serve dropped makes the HTTP client resend
 * the request on a new one by itself, so a call already running there (serve killed) came back as "refused, never
 * sent" instead of "outcome unknown" (B6). One connection per call: nothing resent behind the caller's back.
 */
const clientFor = (path: string): Deno.HttpClient =>
  Deno.createHttpClient({ proxy: { transport: "unix", path }, poolMaxIdlePerHost: 0 });

/** A connection that never opened (no socket, refused): the call was not sent. */
const notSent = (e: unknown) => {
  // fetch wraps the reason: "error sending request" outside, the connect error in `cause` (B6).
  const chain: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 5; x = (x as { cause?: unknown }).cause, i++) {
    chain.push(String(x), String((x as { code?: unknown }).code ?? ""));
  }
  return /ENOENT|ECONNREFUSED|NotFound|ConnectionRefused|No such file|Connection refused|connect error|tcp connect|client error \(Connect\)/i
    .test(chain.join(" "));
};

/**
 * One call to the node listening on `path`. Errors keep the semantics of a call: service_deadline when the caller's
 * deadline passed, service_unavailable when it never reached the serve, service_outcome_unknown when the connection
 * dropped after it was sent (it may or may not have run: the handler decides).
 */
export async function callOver(
  path: string,
  req: CallRequest,
  opts: { deadlineMs: number; traceparent: string | null; signal?: AbortSignal },
): Promise<unknown> {
  const what = `${req.service}.${req.method}`;
  const timeout = AbortSignal.timeout(opts.deadlineMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const client = clientFor(path);
  try {
    return await send(client, path, what, req, opts.traceparent, timeout, signal);
  } finally {
    client.close();
  }
}

async function send(
  client: Deno.HttpClient,
  path: string,
  what: string,
  req: CallRequest,
  traceparent: string | null,
  timeout: AbortSignal,
  signal: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch("http://denobase/call", {
      method: "POST",
      body: JSON.stringify(req),
      headers: { "content-type": "application/json", ...(traceparent ? { traceparent } : {}) },
      client,
      signal,
    });
  } catch (e) {
    if (timeout.aborted) throw svcError(504, "service_deadline", `${what}: no answer within the deadline.`);
    if (signal.aborted) throw svcError(499, "service_canceled", `${what}: the caller gave up.`);
    // A serve is listed as running it: its socket is what this process cannot reach (another host or container, a
    // socket outside pb_data), or it died since its last beat. Either way the call was not sent.
    if (notSent(e)) {
      throw svcError(
        503,
        "service_unavailable",
        `The serve running the ${req.service} service is not reachable on ${path} (it did not run).`,
      );
    }
    throw svcError(502, "service_outcome_unknown", `${what}: the connection dropped; it may or may not have run.`);
  }
  let answer: CallAnswer;
  try {
    answer = await res.json();
  } catch {
    if (timeout.aborted) throw svcError(504, "service_deadline", `${what}: no answer within the deadline.`);
    throw svcError(502, "service_outcome_unknown", `${what}: the answer was cut; it may or may not have run.`);
  }
  if (answer.ok) return fromWire(answer.result);
  const w = answer.error;
  throw typeof w.status === "number"
    ? new ApiError(w.status, w.message, (w.data ?? {}) as ErrorData, w.code)
    : new Error(w.message);
}

/** Nothing pooled to close any more (one client per call); kept for callers that tidy up. */
export function closeClients(): void {}
