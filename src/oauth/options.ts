import type { OAuthOptions, ResolvedOAuthOptions } from "./types.ts";

/** McpOptions.oauth with its defaults. */
export function resolveOAuthOptions(o: OAuthOptions = {}): ResolvedOAuthOptions {
  return {
    enabled: o.enabled ?? true,
    collections: o.collections ?? ["_superusers"],
    scopes: o.scopes ?? [],
    extraResources: o.extraResources ?? [],
    clients: o.clients ?? [],
    introspection: o.introspection ?? false,
    refreshWithoutOfflineAccess: o.refreshWithoutOfflineAccess ?? true,
    locale: o.locale ?? "en",
    branding: o.branding,
    webLogin: o.webLogin,
    renderPage: o.renderPage,
    onAuthorize: o.onAuthorize,
    cimd: o.cimd,
  };
}
