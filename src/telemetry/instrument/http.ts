import type { Context, MiddlewareHandler } from "hono";
import { currentSpan, withSpan } from "../context.ts";
import { formatTraceparent, parseTraceparent } from "../propagation.ts";
import { SpanKind, SpanStatus } from "../span.ts";
import { recordExceptionOnce, type Tracer } from "../tracer.ts";

/**
 * Paths that never open a trace: the admin's own reads of traces and logs (they would trace themselves), the admin
 * UI's files, the dashboard's polling, health checks and the realtime stream (a connection held for minutes).
 */
const EXCLUDED = [
  /^\/api\/traces(\/|$)/,
  /^\/api\/logs(\/|$)/,
  /^\/_\//,
  /^\/api\/_denobase\/stats$/,
  /^\/api\/realtime$/,
  /^\/api\/health$/,
];

export function isTraced(path: string): boolean {
  return !EXCLUDED.some((re) => re.test(path));
}

/** Query keys whose values never reach a span: credentials, OAuth2 codes, and filters (they quote user data). */
const SENSITIVE = /token|code|state|pass|secret|key|auth|sig|session|otp|filter|email|txn/i;

/** url.query with every sensitive value masked and the rest kept, cut at 2000 chars. */
export function redactQuery(search: string): string | undefined {
  if (!search || search === "?") return undefined;
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) out.append(k, SENSITIVE.test(k) ? "[redacted]" : v);
  return out.toString().slice(0, 2000) || undefined;
}

/** The pattern of the route that answered (`/api/collections/:collection/records`), not the url: names group. */
function routeOf(c: Context): string | undefined {
  const routes = c.req.matchedRoutes ?? [];
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (r.method !== "ALL" && r.path !== "*" && r.path !== "/*") return r.path;
  }
  return undefined;
}

/**
 * The root span of each request (`kind=server`, HTTP semconv): joins the caller's trace when it sent a traceparent
 * and answers with the trace's own. 5xx is an error; 4xx stays unset, as OTel says for servers. Registered first, so
 * the activity log and every handler run inside it.
 */
export function tracingMiddleware(
  tracer: Tracer,
  opts: {
    authId?: () => boolean;
    user?: (c: Context) => { id: string } | null | undefined;
    /** Masks the segments of a path that carry a credential (app.redactPath) before url.path is stored. */
    redactPath?: (path: string) => string;
  } = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (!tracer.enabled || !isTraced(c.req.path)) return await next();
    const method = c.req.method.toUpperCase();
    const url = new URL(c.req.url);
    // A request the app makes to itself (a batch's sub-requests) is a child of the span that made it. A client's
    // traceparent is honored only when settings.traces.trustTraceparent says the callers are trusted.
    const spanOpts = {
      kind: SpanKind.server,
      parent: tracer.settings().trustTraceparent ? parseTraceparent(c.req.header("traceparent")) : null,
      attributes: {
        "http.request.method": method,
        "url.path": opts.redactPath ? opts.redactPath(url.pathname) : url.pathname,
        "url.query": redactQuery(url.search),
        "user_agent.original": c.req.header("user-agent")?.slice(0, 500),
      },
    };
    const nested = !!currentSpan();
    const span = nested ? tracer.startSpan(method, spanOpts) : tracer.startRoot(method, spanOpts);
    const header = formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled });
    // A sub-request's answer is read by the app itself, never by a client: no trace headers there.
    if (!nested) {
      c.header("traceparent", header);
      c.header("x-trace-id", span.traceId);
    }
    try {
      await withSpan(span, next);
    } finally {
      const route = routeOf(c);
      if (route) span.setAttribute("http.route", route);
      span.updateName(route ? `${method} ${route}` : method);
      const status = c.res.status;
      span.setAttribute("http.response.status_code", status);
      if (c.error) recordExceptionOnce(span, c.error);
      if (status >= 500) span.setStatus(SpanStatus.error, c.error?.message ?? `HTTP ${status}`);
      const user = opts.user?.(c);
      if (user && opts.authId?.()) span.setAttribute("enduser.id", user.id);
      if (!nested) {
        try {
          // Responses built before the header was set (static files, streams) may carry immutable headers.
          if (!c.res.headers.has("traceparent")) c.res.headers.set("traceparent", header);
          if (!c.res.headers.has("x-trace-id")) c.res.headers.set("x-trace-id", span.traceId);
        } catch { /* immutable headers: the trace still records */ }
      }
      span.end();
    }
  };
}
