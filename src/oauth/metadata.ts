import type { Context, Hono } from "hono";
import type { AppEnv, Ctx } from "../http/app.ts";
import { MCP_PATH, mcpPath, mcpResource } from "../mcp/host.ts";
import type { OAuthCtx } from "./context.ts";

/** RFC 9728 protected resource metadata; also served with the resource path appended (as clients probe first). */
export const METADATA_PATH = "/.well-known/oauth-protected-resource";
const AS_PATH = "/.well-known/oauth-authorization-server";
const OIDC_PATH = "/.well-known/openid-configuration";

export const NO_STORE = { "Cache-Control": "no-store" };

export function baseOf(c: Context<AppEnv>, ctx: Ctx): string {
  return (ctx.settings.meta.appURL || new URL(c.req.url).origin).replace(/\/+$/, "");
}

/** Whether this app answers as an authorization server right now (code and settings both on). */
export const asActive = (o: OAuthCtx | null): o is OAuthCtx => !!o?.enabled;

/** Whether /api/mcp/<collection> is served: an auth collection the embedded server may sign in against. */
export const boundCollection = (o: OAuthCtx | null, slug: string): boolean =>
  asActive(o) && o.collections().some((col) => col.slug === slug);

/**
 * The resource metadata: authorization_servers names this same origin when the embedded server is on. Also served
 * for each collection-bound resource (/api/mcp/<collection>), whose metadata names that resource.
 */
export function protectedResourceRoutes(app: Hono<AppEnv>, ctx: Ctx, o: OAuthCtx | null): void {
  const handler = (c: Context<AppEnv>) => {
    const base = baseOf(c, ctx);
    const collection = c.req.param("collection") ?? "";
    if (collection && !boundCollection(o, collection)) return c.json({ error: "not_found" }, 404);
    return c.json({
      resource: mcpResource(base, collection),
      authorization_servers: asActive(o) ? [base] : [],
      ...(asActive(o) ? { scopes_supported: [...o.scopes.keys()] } : {}),
      bearer_methods_supported: ["header"],
      resource_name: ctx.settings.meta.appName || "denobase",
    });
  };
  app.get(METADATA_PATH, handler);
  app.get(`${METADATA_PATH}${MCP_PATH}`, handler);
  app.get(`${METADATA_PATH}${mcpPath(":collection")}`, handler);
}

/** RFC 8414 authorization server metadata (and the same body at the OIDC discovery path, no id_token). */
export function authorizationServerRoutes(app: Hono<AppEnv>, o: OAuthCtx): void {
  const handler = (c: Context<AppEnv>) => {
    if (!o.enabled) return c.json({ error: "not_found" }, 404);
    const iss = o.issuer(c);
    return c.json(
      {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        ...(o.settings.dcrEnabled ? { registration_endpoint: `${iss}/oauth/register` } : {}),
        revocation_endpoint: `${iss}/oauth/revoke`,
        ...(o.opts.introspection ? { introspection_endpoint: `${iss}/oauth/introspect` } : {}),
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: [...o.scopes.keys()],
        client_id_metadata_document_supported: o.settings.cimdEnabled,
        authorization_response_iss_parameter_supported: true,
      },
      200,
      NO_STORE,
    );
  };
  app.get(AS_PATH, handler);
  app.get(`${AS_PATH}${MCP_PATH}`, handler);
  app.get(OIDC_PATH, handler);
}
