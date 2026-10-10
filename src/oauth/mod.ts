/**
 * The embedded OAuth 2.1 authorization server of the MCP: the app is its own issuer, users authorize a
 * client on server-rendered pages (/oauth/*, own httpOnly session cookie) and the client gets the app's auth JWT
 * (aud = <base>/api/mcp, scope/cid/gid claims) plus a rotating opaque refresh token. Clients register by DCR
 * (RFC 7591), by Client ID Metadata Document (an https client_id) or in code (McpOptions.oauth.clients).
 */
import type { Hono } from "hono";
import type { AppEnv, Ctx } from "../http/app.ts";
import { bundledUi } from "../http/ui_source.ts";
import { OAuthCtx } from "./context.ts";
import { ensureOAuthTables } from "./tables.ts";
import { authorizationServerRoutes, NO_STORE } from "./metadata.ts";
import { authorizeRoutes } from "./authorize.ts";
import { loginRoutes } from "./login.ts";
import { consentRoutes } from "./consent.ts";
import { Flow } from "./flow.ts";
import { tokenRoutes } from "./token.ts";
import { revokeRoutes } from "./revoke.ts";
import { adminRoutes } from "./admin.ts";
import { registerClient } from "./clients.ts";
import { OAuthError } from "./types.ts";
import { realIp } from "../http/logs.ts";
import { LIMITS } from "./ratelimit.ts";
import { ASSETS } from "./pages.ts";

export type {
  AuthorizeEvent,
  ClientKind,
  OAuthBranding,
  OAuthLocale,
  OAuthOptions,
  OAuthScope,
  PageKind,
  StaticClient,
} from "./types.ts";
export { BUILTIN_SCOPES } from "./scopes.ts";
export { cleanupOAuth, ensureOAuthTables } from "./tables.ts";
export { verifyS256 } from "./pkce.ts";
export { isPrivateIp } from "./ssrf.ts";

const UI = bundledUi();

/** Mounts /oauth/*, the AS metadata and /api/oauth/*; null when the MCP or its OAuth is off in code. */
export function oauthRoutes(app: Hono<AppEnv>, ctx: Ctx): OAuthCtx | null {
  const opts = ctx.mcp.options;
  if (!opts.enabled || !opts.oauth.enabled) return null;
  ensureOAuthTables(ctx.db);
  const o = new OAuthCtx(ctx, opts.oauth);
  authorizationServerRoutes(app, o);

  app.post("/oauth/register", async (c) => {
    const json = (body: unknown, status: number) => c.json(body, status as 201, NO_STORE);
    if (!o.enabled || !o.settings.dcrEnabled) {
      return json({ error: "invalid_request", error_description: "Registration is disabled." }, 403);
    }
    const [max, win] = LIMITS.register;
    if (!o.limiter.hit(`register:${realIp(c, ctx)}`, max, win)) {
      return json({ error: "slow_down", error_description: "Too many registrations." }, 429);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ error: "invalid_client_metadata", error_description: "Body must be JSON." }, 400);
    }
    try {
      return json(await registerClient(o, body), 201);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      return json({ error: e.error, error_description: e.description }, e.status);
    }
  });

  const flow = new Flow(o);
  authorizeRoutes(app, flow);
  loginRoutes(app, flow);
  consentRoutes(app, flow);
  tokenRoutes(app, o);
  revokeRoutes(app, o);
  adminRoutes(app, o);

  // The pages' own stylesheet and logo (CSP style-src/img-src 'self'), served even without the admin UI.
  app.get(`${ASSETS}/oauth.css`, async (c) => {
    let css = await readUi("oauth.css") ?? "";
    const accent = o.opts.branding?.accentColor;
    if (accent && /^#[0-9a-fA-F]{3,8}$/.test(accent)) css += `\n:root { --oa-accent: ${accent}; }\n`;
    return c.body(css, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
  });
  app.get(`${ASSETS}/tokens.css`, async (c) => {
    const css = await readUi("css/tokens.css") ?? "";
    return c.body(css, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
  });
  app.get(`${ASSETS}/logo.svg`, async (c) => {
    const svg = await readUi("assets/logo.svg");
    return svg === null
      ? c.body(null, 404)
      : c.body(svg, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
  });
  app.get(`${ASSETS}/font.woff2`, async (c) => {
    const font = await UI.read("assets/fonts/instrument-sans.woff2");
    return font
      ? c.body(font.data, 200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=86400" })
      : c.body(null, 404);
  });
  return o;
}

async function readUi(path: string): Promise<string | null> {
  const file = await UI.read(path);
  return file ? new TextDecoder().decode(file.data) : null;
}
