import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AppEnv, Ctx } from "../http/app.ts";
import { getCollection } from "../core/registry.ts";
import type { CollectionConfig } from "../core/types.ts";
import type { OAuthSettings } from "../settings/mod.ts";
import { mcpResource } from "../mcp/host.ts";
import { sha256 } from "./pkce.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { OAuthClient, OAuthScope, ResolvedOAuthOptions, StaticClient } from "./types.ts";

/** Everything the /oauth routes share, built once when the routes mount. */
export class OAuthCtx {
  readonly scopes: Map<string, OAuthScope>;
  readonly limiter: RateLimiter = new RateLimiter();
  readonly #static = new Map<string, { client: StaticClient; secretHash: Promise<string> }>();

  constructor(readonly http: Ctx, readonly opts: ResolvedOAuthOptions) {
    // One registry for the server and the MCP filter: the host built it from the same options.
    this.scopes = http.mcp.scopes;
    for (const c of opts.clients) {
      if (c.id.startsWith("https://")) throw new Error(`oauth: static client id ${c.id} looks like a CIMD url`);
      this.#static.set(c.id, { client: c, secretHash: sha256(c.secret ?? "") });
    }
  }

  get db(): DatabaseSync {
    return this.http.db;
  }

  get settings(): OAuthSettings {
    return this.http.settings.oauth;
  }

  /** Code and settings both on; the routes answer 404 otherwise, as if not mounted. */
  get enabled(): boolean {
    return this.opts.enabled && this.settings.enabled;
  }

  /** issuer = base: settings.meta.appURL, else the request's origin. No trailing slash. */
  issuer(c: Context<AppEnv>): string {
    return (this.http.settings.meta.appURL || new URL(c.req.url).origin).replace(/\/+$/, "");
  }

  resource(c: Context<AppEnv>): string {
    return mcpResource(this.issuer(c));
  }

  resources(c: Context<AppEnv>): string[] {
    return [this.resource(c), ...this.opts.extraResources];
  }

  /**
   * Who may authorize: superusers only. The MCP is an admin tool; app users sign in through the app's own auth
   * (password, its OAuth2/OIDC providers), never through this server. A list, as the pages and session code ask.
   */
  collections(): CollectionConfig[] {
    try {
      const col = getCollection("_superusers", this.http.collections);
      return col.auth ? [col] : [];
    } catch {
      return []; // not served by this app
    }
  }

  /** The collection every request signs in against (_superusers); null when the app does not serve it. */
  authCollection(): CollectionConfig | null {
    return this.collections()[0] ?? null;
  }

  staticClient(id: string): { client: OAuthClient; secretHash: Promise<string> } | null {
    const s = this.#static.get(id);
    if (!s) return null;
    const c = s.client;
    return {
      secretHash: s.secretHash,
      client: {
        id: c.id,
        kind: "static",
        name: c.name,
        uri: c.uri ?? "",
        logoUri: c.logoUri ?? "",
        redirectUris: c.redirectUris,
        grantTypes: ["authorization_code", "refresh_token"],
        scope: c.scope ?? "",
        authMethod: c.secret ? "client_secret_basic" : "none",
        secretHash: "",
        created: "",
        lastUsed: "",
      },
    };
  }
}
