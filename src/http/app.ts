import type { DatabaseSync } from "node:sqlite";
import { syncExternalCommits } from "../core/coherence.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Mailer } from "../auth/mailer.ts";
import type { AuthUser, CollectionConfig } from "../core/types.ts";
import { ApiError } from "../core/errors.ts";
import type { Services } from "./services.ts";
import { authRoutes, healthRoutes, realtimeRoutes, recordRoutes } from "./routes.ts";
import type { Realtime } from "../realtime/mod.ts";
import type { Settings } from "../settings/mod.ts";
import { batchRoutes } from "./batch.ts";
import { authFlowRoutes } from "./auth_flows.ts";
import { fileRoutes } from "./files.ts";
import { settingsRoutes } from "./settings.ts";
import { activityLogger, logsRoutes } from "./logs.ts";
import type { Logs } from "../logs/mod.ts";
import type { Cron } from "../cron/mod.ts";
import { cronRoutes } from "./crons.ts";
import type { Backups } from "../backups/mod.ts";
import { backupRoutes } from "./backups.ts";
import { withSpoolScope } from "../files/spool.ts";
import { collectionRoutes } from "./collections.ts";
import type { UiSource } from "./ui_source.ts";
import { adminUiRoutes } from "./admin_ui.ts";
import { statsRoutes } from "./stats.ts";
import type { Store } from "../store/mod.ts";
import type { McpHost } from "../mcp/host.ts";
import { audienceAllows, mcpRoutes } from "../mcp/http.ts";
import { oauthRoutes } from "../oauth/mod.ts";
import type { Spans } from "../telemetry/store.ts";
import type { Tracer } from "../telemetry/tracer.ts";
import { tracingMiddleware } from "../telemetry/instrument/http.ts";
import { traced } from "../telemetry/instrument/child.ts";
import { traceRoutes } from "./traces.ts";

export type AppEnv = { Variables: { user: AuthUser | null } };

/** What routes see of the App, resolved so they never re-check optionals. */
export interface Ctx {
  db: DatabaseSync;
  store: Store;
  mailer: Mailer;
  collections: CollectionConfig[];
  s: Services;
  realtime: Realtime;
  settings: Settings;
  /** Called after PATCH /api/settings saved new values (crons reload the backup schedule). */
  onSettingsChange: ((s: Settings) => void)[];
  logs: Logs;
  tracer: Tracer;
  traces: Spans;
  cron: Cron;
  /** null without a pb_data dir: the backups API then answers PB's filesystem error. */
  backups: Backups | null;
  /** Admin UI to serve at /_/; unset, there is no UI. */
  adminUi?: UiSource;
  /** The app's MCP (POST /api/mcp); its registry is app.mcp. */
  mcp: McpHost;
}

/** PB accepts both "Bearer x" and a raw token in Authorization. */
export function tokenFromHeader(h: string | undefined): string | null {
  if (!h) return null;
  const t = h.startsWith("Bearer ") ? h.slice(7) : h;
  return t.trim() || null;
}

/** DENOBASE_ORIGINS as a list, or "*" (PB's default) when unset or empty. */
export function corsOrigins(raw = Deno.env.get("DENOBASE_ORIGINS") ?? ""): string | string[] {
  const list = raw.split(",").map((o) => o.trim()).filter(Boolean);
  return list.length === 0 || list.includes("*") ? "*" : list;
}

/** Hono app over the App's parts: auth middleware (Bearer/raw token), ApiError -> PB JSON, routes. */
export function createHttp(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // First, so the activity log and every handler run inside the request's root span.
  app.use(
    "*",
    tracingMiddleware(ctx.tracer, { authId: () => ctx.settings.logs.logAuthId, user: (c) => c.get("user") }),
  );
  // PB's CORS middleware: every origin by default (`--origins`), so a front on another port or host can call the
  // API; DENOBASE_ORIGINS narrows it to a comma-separated list. Preflights answer here, before auth and routes.
  app.use("*", cors({ origin: corsOrigins(), maxAge: 86400 }));
  // A request is an entry point: what another thread committed since the last one invalidates this thread's caches.
  app.use("*", async (_c, next) => {
    syncExternalCommits(ctx.db);
    await next();
  });
  app.use("*", activityLogger(ctx));
  // Multipart uploads spool to temp files for the request; they go when it ends, stored or not.
  app.use("*", (_c, next) => withSpoolScope(next));
  // Invalid tokens resolve to guest like PB; endpoints that need auth answer 401 themselves. So does a token minted
  // for another audience (app.mcp.token): it only opens /api/mcp.
  app.use("*", async (c, next) => {
    const token = tokenFromHeader(c.req.header("Authorization"));
    const scoped = token && !audienceAllows(token, c.req.path);
    // Its own span, so the token check (user lookup + HMAC) is visible apart from the handler in the waterfall.
    c.set(
      "user",
      token && !scoped ? await traced("auth.verify", {}, () => ctx.s.verifyAuthToken(ctx.db, token)) : null,
    );
    await next();
  });
  app.onError((err, c) => {
    const e = err instanceof ApiError ? err : new ApiError(500, "Something went wrong while processing your request.");
    if (!(err instanceof ApiError)) console.error(err);
    return c.json(e.toJSON(), e.status as 400);
  });
  app.notFound((c) => c.json(new ApiError(404, "The requested resource wasn't found.").toJSON(), 404));
  recordRoutes(app, ctx);
  authRoutes(app, ctx);
  authFlowRoutes(app, ctx);
  realtimeRoutes(app, ctx);
  healthRoutes(app);
  batchRoutes(app, ctx);
  fileRoutes(app, ctx);
  settingsRoutes(app, ctx);
  logsRoutes(app, ctx);
  traceRoutes(app, ctx);
  cronRoutes(app, ctx);
  backupRoutes(app, ctx);
  collectionRoutes(app, ctx);
  statsRoutes(app, ctx);
  // /oauth/* lives outside /api: its endpoints authenticate clients and browsers themselves, never by Bearer.
  mcpRoutes(app, ctx, oauthRoutes(app, ctx));
  if (ctx.adminUi) adminUiRoutes(app, ctx.adminUi);
  return app;
}
