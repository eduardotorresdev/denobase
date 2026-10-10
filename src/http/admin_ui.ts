import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import type { UiSource } from "./ui_source.ts";

/** PB's default CSP. */
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* " +
  "https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* " +
  "https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";

/**
 * The Denobase admin UI (ui/, plain ES modules on shablon) at /_/, where PB mounts its own.
 * It only talks to the REST API. Unknown paths fall back to index.html (client-side routes), except under
 * /_/api/: those belong to the consumer's routes (PB served its own /_/ routes ahead of the UI the same way),
 * which are mounted after the UI, so the fallback passes them on.
 */
export function adminUiRoutes(app: Hono<AppEnv>, ui: UiSource, base = "/_"): void {
  app.get(base, (c) => c.redirect(`${base}/`, 301));
  app.get(`${base}/*`, async (c, next) => {
    const rel = decodeURIComponent(c.req.path.slice(base.length + 1));
    if (rel === "api" || rel.startsWith("api/")) return await next();
    if (rel.split("/").some((p) => p === "..")) return c.notFound();
    // A path that is not a file is a client-side route.
    const file = (rel ? await ui.read(rel) : null) ?? await ui.read("index.html");
    if (!file) return c.notFound();
    return new Response(file.data, {
      headers: {
        "Content-Type": file.type,
        "Content-Security-Policy": CSP,
        // Module names do not change between releases, so nothing is cached without revalidation.
        "Cache-Control": "no-cache",
      },
    });
  });
}
