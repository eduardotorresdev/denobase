import type { OAuthCtx } from "./context.ts";
import { redirectUriProblem, rowToClient } from "./clients.ts";
import { safeFetch } from "./ssrf.ts";
import type { OAuthClient } from "./types.ts";

const MIN_CACHE_S = 300;
const MAX_CACHE_S = 86_400;

/** A CIMD client_id: https, a path besides "/", no fragment, credentials, dot segments or port other than 443. */
export function cimdIdProblem(id: string): string | null {
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "not https";
  if (u.username || u.password) return "credentials";
  if (u.hash || id.includes("#")) return "fragment";
  if (u.port && u.port !== "443") return "port";
  if (u.pathname === "/" || !u.pathname) return "no path";
  if (/\/\.\.?(\/|$)/.test(id.slice(u.origin.length))) return "dot segment";
  return null;
}

function domainAllowed(host: string, allow: string[], deny: string[]): boolean {
  const under = (d: string) => host === d || host.endsWith(`.${d}`);
  if (deny.some(under)) return false;
  return !allow.length || allow.some(under);
}

function maxAge(cacheControl: string | null): number {
  const m = cacheControl?.match(/max-age=(\d+)/i);
  const s = m ? Number(m[1]) : 0;
  return Math.min(MAX_CACHE_S, Math.max(MIN_CACHE_S, s));
}

/**
 * The client a CIMD client_id names: its metadata document fetched (SSRF-guarded) and cached in _oauth_clients for
 * Cache-Control max-age, clamped to 5 min .. 24 h. The document's client_id must be the URL itself; its redirect
 * URIs pass the DCR rules; it is always a public client (PKCE). null when it cannot be used.
 */
export async function resolveCimdClient(o: OAuthCtx, id: string): Promise<OAuthClient | null> {
  if (cimdIdProblem(id)) return null;
  const host = new URL(id).hostname;
  if (!domainAllowed(host, o.settings.cimdAllowDomains, o.settings.cimdDenyDomains)) return null;
  const now = Date.now();
  const cached = o.db.prepare(`SELECT * FROM _oauth_clients WHERE id = ? AND kind = 'cimd'`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (cached && Number(cached.expiresAt) > now) return rowToClient(cached);
  let doc: Record<string, unknown>;
  let ttl: number;
  try {
    const res = await safeFetch(id, { fetch: o.opts.cimd?.fetch, resolve: o.opts.cimd?.resolve });
    if (res.status !== 200) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/^application\/([a-z0-9.+-]*\+)?json\b/i.test(type)) return null;
    doc = JSON.parse(res.bodyText);
    ttl = maxAge(res.headers.get("cache-control"));
  } catch (e) {
    console.error("oauth: cimd fetch failed", id, (e as Error).message);
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.client_id !== id) return null;
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) return null;
  if (uris.some((u) => redirectUriProblem(u as string, o.settings))) return null;
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const https = (v: unknown) => {
    const s = text(v, 2000);
    return s && URL.canParse(s) && new URL(s).protocol === "https:" ? s : "";
  };
  const created = cached ? String(cached.created) : new Date(now).toISOString();
  o.db.prepare(
    `INSERT OR REPLACE INTO _oauth_clients (id, kind, name, uri, logoUri, redirectUris, grantTypes, scope, authMethod,
      secretHash, metadataJSON, fetchedAt, expiresAt, created, lastUsed)
     VALUES (?, 'cimd', ?, ?, ?, ?, ?, ?, 'none', '', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    text(doc.client_name, 200),
    https(doc.client_uri),
    https(doc.logo_uri),
    JSON.stringify(uris),
    JSON.stringify(["authorization_code", "refresh_token"]),
    text(doc.scope, 1000),
    JSON.stringify(doc).slice(0, 10_000),
    now,
    now + ttl * 1000,
    created,
    cached ? String(cached.lastUsed ?? "") : "",
  );
  const row = o.db.prepare(`SELECT * FROM _oauth_clients WHERE id = ?`).get(id) as Record<string, unknown>;
  return rowToClient(row);
}
