import type { AuthUser } from "../core/types.ts";

/** One scope a token may carry. `tools` narrows which MCP tools it opens; without it, the scope opens none. */
export interface OAuthScope {
  name: string;
  description: string;
  tools?: string[] | ((tool: { name: string; readOnly: boolean }) => boolean);
}

/** A pre-registered client (confidential when it has a secret). */
export interface StaticClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** Plain secret given in code (env); only its hash is kept in memory. Unset: a public client (PKCE only). */
  secret?: string;
  scope?: string;
  logoUri?: string;
  uri?: string;
  /**
   * The auth collection this client always signs in against. A request may then omit `auth_collection` or repeat this
   * same value; any other is invalid_request.
   */
  authCollection?: string;
}

/** What an authorization is about, as onAuthorize sees it. */
export interface AuthorizeEvent {
  user: AuthUser;
  client: { id: string; name: string; kind: ClientKind };
  scopes: string[];
  resource: string;
}

/** The pages the authorization server renders. */
export type PageKind = "login" | "otp" | "consent" | "done" | "error";

export interface OAuthBranding {
  name?: string;
  logoUrl?: string;
  accentColor?: string;
  /** An extra stylesheet (same origin, CSP style-src 'self'). */
  cssHref?: string;
}

/** McpOptions.oauth: the embedded authorization server, set in code by the consumer. */
export interface OAuthOptions {
  /** Default true (when the MCP is enabled); settings.oauth.enabled can still turn it off at runtime. */
  enabled?: boolean;
  /**
   * Auth collections whose records may authorize. Default ["_superusers"]. Which one a request signs in against is
   * chosen by whoever starts it (`auth_collection` on /oauth/authorize, else settings.oauth.defaultCollection), never
   * by the login page, which stays the same for all of them.
   */
  collections?: string[];
  /** Scopes besides mcp, mcp:read, mcp:write and offline_access. */
  scopes?: OAuthScope[];
  /** Other resource URLs (RFC 8707) a token may be requested for besides <base>/api/mcp. */
  extraResources?: string[];
  branding?: OAuthBranding;
  /** Language of the pages the user sees. Default "en". */
  locale?: OAuthLocale;
  /**
   * The consumer's handoff page, where the user may already be signed in (any origin). When a request has no session
   * of its own, GET /oauth/authorize sends the browser there once, silently, as `url?oauth_txn=<txn>`; the page calls
   * `POST /oauth/handoff` with its own auth token and `{ txn }` and goes to the `url` it answers, or, with no token or
   * on any error, back to `<issuer>/oauth/authorize?txn=<txn>` (contract in CONTRACTS.md). Without it, the admin UI
   * (`/_/#/oauth-handoff`) plays that page when superusers may authorize.
   */
  webLogin?: { url: string };
  /** Replaces a page's HTML; return undefined to keep the built-in one. Escaping is then the consumer's. */
  renderPage?(kind: PageKind, data: Record<string, unknown>): string | undefined;
  /** Last word on an authorization: false denies, a list narrows the scopes. */
  onAuthorize?(e: AuthorizeEvent): boolean | string[] | Promise<boolean | string[]>;
  clients?: StaticClient[];
  /** RFC 7662 at /oauth/introspect (superuser or confidential client). Default false. */
  introspection?: boolean;
  /** Issue a refresh token to clients that did not ask for offline_access (MCP clients expect one). Default true. */
  refreshWithoutOfflineAccess?: boolean;
  /** Client ID Metadata Document transport; tests and proxies swap them. */
  cimd?: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> };
}

export type OAuthLocale = "en" | "pt-BR";

type Optional = "renderPage" | "onAuthorize" | "branding" | "cimd" | "webLogin";
export type ResolvedOAuthOptions = Required<Omit<OAuthOptions, Optional>> & Pick<OAuthOptions, Optional>;

export type ClientKind = "dcr" | "cimd" | "static";

/** A row of _oauth_clients (static clients are synthesized from code, never stored). */
export interface OAuthClient {
  id: string;
  kind: ClientKind;
  name: string;
  uri: string;
  logoUri: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string;
  authMethod: "none" | "client_secret_post" | "client_secret_basic";
  secretHash: string;
  created: string;
  lastUsed: string;
  /** Static clients only: the auth collection the client always signs in against. */
  authCollection?: string;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  collection: string;
  recordId: string;
  resource: string;
  scope: string;
  rememberConsent: number;
  created: string;
  lastUsed: string;
  revokedAt: string | null;
}

/** A pending /oauth/authorize, validated and kept server side; the pages only carry its id (txn). */
export interface OAuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  prompt: string;
  created: number;
  expires: number;
  consumed: number;
  /** 1 when redirect_uri came in the request; else the token endpoint must not demand it (RFC 6749 §4.1.3). */
  redirectUriSent: number;
  /** Form token of the login and code forms, before any session exists. */
  csrf: string;
  /** SHA-256 of the browser cookie that started the request: only that browser may sign in to it. */
  bindHash: string;
  /** The auth collection this request signs in against (auth_collection), fixed when it was validated. */
  collection: string;
  /** 1 once the silent handoff (the web app's own session) was tried for this request: once per request, never more. */
  webTried: number;
}

export interface OAuthSession {
  idHash: string;
  collection: string;
  recordId: string;
  csrf: string;
  keyHash: string;
  created: number;
  expires: number;
}

/** An OAuth error: where it goes is decided by the caller (JSON, page or redirect). */
export class OAuthError extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) {
    super(description);
  }
}
