import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv, Ctx } from "./app.ts";
import { ApiError, notFound } from "../core/errors.ts";
import { LEVEL } from "../logs/mod.ts";
import { requireSuperuser } from "./guards.ts";
import { parseFields, pickFields } from "../query/helpers.ts";
import { clientIp } from "./routes.ts";
import { redactQuery } from "../telemetry/instrument/http.ts";

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}...` : s);

/** PB RealIP: the first trusted proxy header present (leftmost or rightmost entry), else the remote address. */
export function realIp(c: Context<AppEnv>, ctx: Ctx): string {
  const { headers, useLeftmostIP } = ctx.settings.trustedProxy;
  for (const h of headers) {
    const v = c.req.header(h);
    if (!v) continue;
    const ips = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (ips.length) return useLeftmostIP ? ips[0] : ips[ips.length - 1];
  }
  return clientIp(c);
}

/** PB activity logger: one _logs row per request, errors at level ERROR. */
export function activityLogger(ctx: Ctx): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const cfg = ctx.settings.logs;
    if (cfg.maxDays === 0) return;
    const status = c.res.status;
    const failed = status >= 400;
    // PB SkipSuccessActivityLog on the logs API and the admin UI's static files, so they do not flood the logs.
    if (
      !failed &&
      (c.req.path.startsWith("/api/logs") || c.req.path.startsWith("/_/"))
    ) return;
    // MCP logs one line per tool call itself; its POSTs and the 405 every client's SSE probe gets would only add noise.
    if (c.req.path === "/api/mcp" && (!failed || status === 405)) return;
    const level = failed ? LEVEL.error : LEVEL.info;
    if (level < cfg.minLevel) return;
    const u = new URL(c.req.url);
    // /oauth/* carries state, challenges and client ids in the query: masked like the traces' url.query.
    const search = u.pathname.startsWith("/oauth/") && u.search ? `?${redactQuery(u.search) ?? ""}` : u.search;
    // A path that carries a credential (app.redactPath) is stored with that segment masked.
    const url = cut(ctx.redactor.redact(u.pathname) + search, 3000);
    const method = cut(c.req.method.toUpperCase(), 50);
    const user = c.get("user");
    const data: Record<string, unknown> = { type: "request", execTime: performance.now() - started };
    if (failed) {
      const e = c.error instanceof ApiError ? c.error : undefined;
      data.error = e?.message ?? c.error?.message ?? "";
      if (e) data.details = e.data;
    }
    Object.assign(data, {
      url,
      method,
      status,
      referer: cut(c.req.header("referer") ?? "", 2000),
      userAgent: cut(c.req.header("user-agent") ?? "", 2000),
      auth: user?.collection ?? "",
    });
    if (user && cfg.logAuthId) data.authId = user.id;
    if (cfg.logIP) Object.assign(data, { userIP: realIp(c, ctx), remoteIP: clientIp(c) });
    let message = `${method} ${url}`;
    try {
      message = `${method} ${decodeURI(url)}`;
    } catch { /* keep the raw uri */ }
    try {
      ctx.logs.add(level, message, data, cfg.maxDataSize);
    } catch (e) {
      console.error("activity log failed", e);
    }
  };
}

const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** PB logs routes: superuser-only list, stats, view and truncate. */
export function logsRoutes(app: Hono<AppEnv>, ctx: Ctx): void {
  app.use("/api/logs", async (c, next) => (requireSuperuser(c), await next()));
  app.use("/api/logs/*", async (c, next) => (requireSuperuser(c), await next()));
  app.get("/api/logs", (c) => {
    const q = c.req.query();
    const out = ctx.logs.list({
      filter: q.filter,
      sort: q.sort,
      page: int(q.page),
      perPage: int(q.perPage),
      skipTotal: ["1", "t", "true"].includes((q.skipTotal ?? "").toLowerCase()),
    });
    const tree = q.fields ? parseFields(q.fields) : null;
    return c.json(tree ? { ...out, items: out.items.map((l) => pickFields(l as never, tree)) } : out);
  });
  app.delete("/api/logs", (c) => {
    ctx.logs.truncate();
    return c.body(null, 204);
  });
  app.get("/api/logs/stats", (c) => c.json(ctx.logs.stats(c.req.query("filter"))));
  app.get("/api/logs/:id", (c) => {
    const log = ctx.logs.get(c.req.param("id"));
    if (!log) throw notFound();
    return c.json(log);
  });
}
