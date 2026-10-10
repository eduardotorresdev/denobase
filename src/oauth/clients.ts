import type { DatabaseSync } from "node:sqlite";
import type { OAuthSettings } from "../settings/mod.ts";
import type { OAuthCtx } from "./context.ts";
import { randomToken, safeEqual, sha256 } from "./pkce.ts";
import { resolveRequestedScopes } from "./scopes.ts";
import { type OAuthClient, OAuthError } from "./types.ts";
import { resolveCimdClient } from "./cimd.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const MAX_REDIRECTS = 10;

export function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/**
 * Whether a redirect URI may be registered: https (host in allowedRedirectHosts when set), or loopback http when
 * allowed; never a fragment or a wildcard. Returns the reason it may not, or null.
 */
export function redirectUriProblem(uri: string, s: Pick<OAuthSettings, "allowLoopback" | "allowedRedirectHosts">) {
  if (typeof uri !== "string" || !uri) return "redirect_uri is required";
  if (uri.includes("#")) return "redirect_uri must not have a fragment";
  if (uri.includes("*")) return "redirect_uri must not have a wildcard";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "redirect_uri is not a URL";
  }
  if (u.username || u.password) return "redirect_uri must not carry credentials";
  if (isLoopback(u)) return s.allowLoopback ? null : "loopback redirects are disabled";
  if (u.protocol !== "https:") return "redirect_uri must be https (or http on loopback)";
  if (s.allowedRedirectHosts.length && !s.allowedRedirectHosts.includes(u.hostname)) {
    return "redirect_uri host is not allowed";
  }
  return null;
}

/**
 * The requested redirect against the registered ones: byte for byte, except a loopback one, whose port may differ
 * (RFC 8252 §7.3) while scheme, host, path and query stay identical.
 */
export function redirectMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(r) || requested.includes("#")) return false;
  return registered.some((reg) => {
    try {
      const u = new URL(reg);
      return isLoopback(u) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

type Row = Record<string, unknown>;

export function rowToClient(r: Row): OAuthClient {
  return {
    id: String(r.id),
    kind: r.kind as OAuthClient["kind"],
    name: String(r.name ?? ""),
    uri: String(r.uri ?? ""),
    logoUri: String(r.logoUri ?? ""),
    redirectUris: JSON.parse(String(r.redirectUris ?? "[]")),
    grantTypes: JSON.parse(String(r.grantTypes ?? "[]")),
    scope: String(r.scope ?? ""),
    authMethod: r.authMethod as OAuthClient["authMethod"],
    secretHash: String(r.secretHash ?? ""),
    created: String(r.created ?? ""),
    lastUsed: String(r.lastUsed ?? ""),
  };
}

export function storedClient(db: DatabaseSync, id: string): OAuthClient | null {
  const r = db.prepare(`SELECT * FROM _oauth_clients WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToClient(r) : null;
}

/** Static from code, an https URL through CIMD, else a stored (DCR) client; null when unknown. */
export async function resolveClient(o: OAuthCtx, id: string): Promise<OAuthClient | null> {
  if (!id || id.length > 512) return null;
  const st = o.staticClient(id);
  if (st) return st.client;
  if (id.startsWith("https://")) return o.settings.cimdEnabled ? await resolveCimdClient(o, id) : null;
  const c = storedClient(o.db, id);
  return c && c.kind === "dcr" ? c : null;
}

/** Token and revoke endpoints: client_secret_basic, client_secret_post, or none for a public client. */
export async function authenticateClient(
  o: OAuthCtx,
  headers: Headers,
  form: URLSearchParams,
): Promise<OAuthClient> {
  let id = form.get("client_id") ?? "";
  let secret: string | null = form.get("client_secret");
  let method: OAuthClient["authMethod"] = secret !== null ? "client_secret_post" : "none";
  const basic = headers.get("authorization");
  if (basic?.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(basic.slice(6).trim());
    } catch { /* invalid_client below */ }
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "Malformed basic credentials.", 401);
    const bid = decodeURIComponent(decoded.slice(0, i));
    if (id && id !== bid) throw new OAuthError("invalid_request", "client_id does not match the credentials.");
    id = bid;
    secret = decodeURIComponent(decoded.slice(i + 1));
    method = "client_secret_basic";
  }
  const client = await resolveClient(o, id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
  const expected = client.kind === "static" ? await o.staticClient(id)!.secretHash : client.secretHash;
  if (client.authMethod === "none") {
    if (secret) throw new OAuthError("invalid_client", "This client is public: send no secret.", 401);
    return client;
  }
  // Either secret method is accepted for a confidential client; what matters is the secret.
  if (method === "none" || !secret || !safeEqual(await sha256(secret), expected)) {
    throw new OAuthError("invalid_client", "Client authentication failed.", 401);
  }
  return client;
}

export function touchClient(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE _oauth_clients SET lastUsed = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

function httpsOrEmpty(v: unknown): string | null {
  if (v === undefined || v === "") return "";
  const s = str(v, 2000);
  if (!s || !URL.canParse(s) || new URL(s).protocol !== "https:") return null;
  return s;
}

/**
 * RFC 7591 registration. Returns the response body; the secret (confidential clients only) is shown once and
 * stored as its hash.
 */
export async function registerClient(o: OAuthCtx, body: unknown): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS) {
    throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECTS} URIs.`);
  }
  for (const u of uris) {
    const p = redirectUriProblem(u as string, o.settings);
    if (p) throw new OAuthError("invalid_redirect_uri", p);
  }
  const name = b.client_name === undefined ? "" : str(b.client_name, 200);
  if (name === undefined) throw new OAuthError("invalid_client_metadata", "client_name must be a short string.");
  const uri = httpsOrEmpty(b.client_uri);
  const logo = httpsOrEmpty(b.logo_uri);
  if (uri === null || logo === null) {
    throw new OAuthError("invalid_client_metadata", "client_uri and logo_uri must be https URLs.");
  }
  const method = (b.token_endpoint_auth_method ?? "client_secret_basic") as string;
  if (!(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${AUTH_METHODS}.`);
  }
  const grants = b.grant_types === undefined ? GRANT_TYPES : b.grant_types;
  if (!Array.isArray(grants) || !grants.length || grants.some((g) => !GRANT_TYPES.includes(g as string))) {
    throw new OAuthError("invalid_client_metadata", "grant_types may only hold authorization_code and refresh_token.");
  }
  if (!grants.includes("authorization_code")) {
    throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code.");
  }
  if (b.response_types !== undefined) {
    const rt = b.response_types;
    if (!Array.isArray(rt) || rt.some((x) => x !== "code")) {
      throw new OAuthError("invalid_client_metadata", "Only the code response type is supported.");
    }
  }
  let scope = "";
  if (b.scope !== undefined) {
    const s = str(b.scope, 1000);
    if (s === undefined || !resolveRequestedScopes(s, o.scopes, "")) {
      throw new OAuthError("invalid_client_metadata", "Unknown scope.");
    }
    scope = s;
  }
  const id = randomToken(16);
  const secret = method === "none" ? "" : randomToken(32);
  const now = new Date();
  o.db.prepare(
    `INSERT INTO _oauth_clients (id, kind, name, uri, logoUri, redirectUris, grantTypes, scope, authMethod, secretHash,
      metadataJSON, created) VALUES (?, 'dcr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    uri,
    logo,
    JSON.stringify(uris),
    JSON.stringify(grants),
    scope,
    method,
    secret ? await sha256(secret) : "",
    JSON.stringify(b).slice(0, 10_000),
    now.toISOString(),
  );
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    ...(uri ? { client_uri: uri } : {}),
    ...(logo ? { logo_uri: logo } : {}),
    redirect_uris: uris,
    grant_types: grants,
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(scope ? { scope } : {}),
  };
}
