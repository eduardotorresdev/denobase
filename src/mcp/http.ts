import type { Context, Hono } from "hono";
import { type AppEnv, type Ctx, tokenFromHeader } from "../http/app.ts";
import { tokenClaims } from "../auth/jwt.ts";
import { MCP_PATH, mcpResource } from "./host.ts";
import type { McpHost } from "./host.ts";
import type { OAuthCtx } from "../oauth/context.ts";
import { METADATA_PATH, protectedResourceRoutes } from "../oauth/metadata.ts";
import { grantActive } from "../oauth/tables.ts";
import { splitScope, toolAllowed } from "../oauth/scopes.ts";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * POST /api/mcp (Streamable HTTP, 2026-07-28 and the 2025-11-25 stateless fallback; GET/DELETE answer 405 once
 * authenticated) and the RFC 9728 metadata. Auth is the app's: the global middleware already turned the Bearer into
 * c.get("user"); here, for every method, guests get 401 + WWW-Authenticate unless allowGuest, and a token without
 * the MCP audience is refused when requireAudience (the default). The principal reaches the server factory as
 * authInfo.extra.user. An OAuth access token (src/oauth) also carries gid, checked live so a revoked grant stops at
 * once, and its scopes, which narrow the tools (403 insufficient_scope on a call outside them).
 */
export function mcpRoutes(app: Hono<AppEnv>, ctx: Ctx, oauth: OAuthCtx | null = null): void {
  const host = ctx.mcp;
  if (!host.options.enabled) return;
  const base = (c: Context<AppEnv>) => (ctx.settings.meta.appURL || new URL(c.req.url).origin).replace(/\/+$/, "");

  protectedResourceRoutes(app, ctx, oauth);

  app.all(MCP_PATH, async (c) => {
    if (!originAllowed(c, ctx, host.options.allowedOrigins)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Origin not allowed." } }, 403);
    }
    const user = c.get("user");
    const token = tokenFromHeader(c.req.header("Authorization"));
    // Every method, not only POST: a GET stream the SDK may serve one day opens behind the same checks.
    const challenge = `Bearer resource_metadata="${base(c)}${METADATA_PATH}"`;
    const refuse = (message: string) => {
      c.header("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, 401);
    };
    if (!user && !host.options.allowGuest) {
      // A token that did not verify (expired, revoked tokenKey) says so, so the client refreshes instead of asking.
      if (token) return refuse("Invalid or expired token.");
      c.header("WWW-Authenticate", challenge);
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Authentication required." } }, 401);
    }
    const claims = tokenClaims(token ?? "");
    if (user && host.options.requireAudience && claims.aud !== mcpResource(base(c))) {
      return refuse("Token not issued for this MCP server.");
    }
    if (user && claims.gid && !grantActive(ctx.db, claims.gid)) return refuse("The authorization was revoked.");
    // Only OAuth tokens carry scopes; a manual app.mcp.token keeps today's full access.
    const scopes = user && claims.gid ? splitScope(claims.scope) : undefined;
    if (scopes) {
      const missing = await outOfScope(c, host, scopes);
      if (missing) {
        c.header(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${missing}", resource_metadata="${base(c)}${METADATA_PATH}"`,
        );
        return c.json(
          { jsonrpc: "2.0", id: null, error: { code: -32001, message: "The token's scope does not allow this tool." } },
          403,
        );
      }
    }
    return await host.handler.fetch(c.req.raw, {
      authInfo: {
        token: token ?? "",
        clientId: claims.cid ?? user?.collection ?? "guest",
        scopes: scopes ?? [],
        extra: { user, scopes },
      },
    });
  });
}

/**
 * The scope a tools/call needs when the token's scopes do not open that tool (a registered one: an unknown name is
 * the SDK's own error); null when every call in the body is allowed. Reads a clone, so the SDK still gets the body.
 */
async function outOfScope(c: Context<AppEnv>, host: McpHost, scopes: string[]): Promise<string | null> {
  if (c.req.method !== "POST") return null;
  let body: unknown;
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return null;
  }
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
    if (m?.method !== "tools/call" || typeof m.params?.name !== "string") continue;
    const def = host.registry.tools.get(m.params.name);
    if (!def) continue;
    const tool = { name: def.name, readOnly: !!def.annotations?.readOnly };
    if (toolAllowed(tool, scopes, host.scopes)) continue;
    return toolAllowed(tool, ["mcp:write"], host.scopes) ? "mcp:write" : "mcp";
  }
  return null;
}

/** A token with an `aud` (an MCP token) authenticates only on /api/mcp; one without it, anywhere (PB's tokens). */
export function audienceAllows(token: string, path: string): boolean {
  return tokenClaims(token).aud === undefined || path === MCP_PATH;
}

/** DNS-rebinding guard: no Origin (non-browser clients) passes; a browser must be local, same-origin or listed. */
function originAllowed(c: Context<AppEnv>, ctx: Ctx, extra: string[]): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (LOCAL.has(u.hostname)) return true;
  if (u.origin === new URL(c.req.url).origin) return true;
  const appURL = ctx.settings.meta.appURL;
  if (appURL && URL.canParse(appURL) && new URL(appURL).origin === u.origin) return true;
  return extra.includes(u.origin);
}
