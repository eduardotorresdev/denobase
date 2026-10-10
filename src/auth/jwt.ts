import type { DatabaseSync } from "node:sqlite";
import { collectionId, getCollection } from "../core/registry.ts";
import { create, decode, getNumericDate, verify } from "jwt";
import { traceQuery } from "../telemetry/instrument/store.ts";
import type { AuthUser, CollectionConfig, Doc } from "../core/types.ts";

/** PB token types; each signs with its own secret so one kind never passes as another. */
export type TokenType = "auth" | "file" | "verification" | "passwordReset" | "emailChange";

/** PB claims: `collectionId` is the pbc_ id (the JS SDK reads it to tell superusers apart). */
export interface TokenClaims {
  collectionId: string;
  exp: number;
  id: string;
  type: TokenType;
  refreshable?: boolean;
  email?: string;
  newEmail?: string;
  /** RFC 8707 audience; set on tokens scoped to one resource (the MCP endpoint). */
  aud?: string;
  /** OAuth access tokens only: granted scopes (space separated), client id and grant id. */
  scope?: string;
  cid?: string;
  gid?: string;
}

/** PB default durations, in seconds. */
export const TOKEN_TTL: Record<TokenType, number> = {
  auth: 432000,
  file: 180,
  verification: 86400,
  passwordReset: 1800,
  emailChange: 1800,
};

// Local quoting (same rule as schema.quoteIdent) keeps auth free of the schema module.
export const quoteIdent = (n: string) => `"${n.replaceAll('"', '""')}"`;

function appSecret(): string {
  return Deno.env.get("APP_SECRET") ?? "dev-insecure-secret";
}

/** Imported HMAC keys by secret material: importKey per request was the hot part of every auth verify. */
const KEY_CACHE_MAX = 1000;
const keyCache = new Map<string, Promise<CryptoKey>>();

/** PB key = record tokenKey + the collection's per-type secret; ours derives that secret from APP_SECRET. */
function hmacKey(tokenKey: string, slug: string, type: TokenType): Promise<CryptoKey> {
  const material = `${tokenKey}${appSecret()}:${slug}:${type}`;
  const hit = keyCache.get(material);
  if (hit) {
    // LRU: a hit moves to the newest end.
    keyCache.delete(material);
    keyCache.set(material, hit);
    return hit;
  }
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  key.catch(() => keyCache.delete(material));
  keyCache.set(material, key);
  if (keyCache.size > KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
  return key;
}

/** Test hook: how many keys the cache holds. */
export const hmacKeyCacheSize = (): number => keyCache.size;

function ttlOf(col: CollectionConfig, type: TokenType): number {
  const configured = type === "auth" && typeof col.auth === "object" ? col.auth.tokenExpiration : undefined;
  return configured ?? TOKEN_TTL[type];
}

export interface SignOptions {
  /** Seconds; defaults to the collection duration for the type. */
  ttl?: number;
  /** Auth tokens only: false for impersonate's static tokens, which auth-refresh hands back unchanged. */
  refreshable?: boolean;
  email?: string;
  newEmail?: string;
  /** Audience claim (RFC 8707 resource); PB tokens carry none. */
  aud?: string;
  /** OAuth access tokens (src/oauth): scope, client id and grant id claims. */
  oauth?: { scope: string; cid: string; gid: string };
}

/** Signs a PB-shaped token of `type` for an auth record; changing the record's tokenKey kills every token. */
export async function signToken(
  collection: string,
  record: { id: string; tokenKey: string },
  type: TokenType,
  opts: SignOptions = {},
): Promise<string> {
  const col = getCollection(collection);
  const ttl = opts.ttl ?? ttlOf(col, type);
  const claims: TokenClaims = {
    collectionId: collectionId(col),
    exp: getNumericDate(ttl),
    id: record.id,
    type,
    ...(type === "auth" ? { refreshable: opts.refreshable ?? true } : {}),
    ...(opts.email !== undefined ? { email: opts.email } : {}),
    ...(opts.newEmail !== undefined ? { newEmail: opts.newEmail } : {}),
    ...(opts.aud !== undefined ? { aud: opts.aud } : {}),
    ...(opts.oauth ?? {}),
  };
  return create({ alg: "HS256", typ: "JWT" }, { ...claims }, await hmacKey(record.tokenKey, col.slug, type));
}

export function signAuthToken(
  collection: string,
  record: { id: string; tokenKey: string },
  ttl?: number,
  refreshable = true,
): Promise<string> {
  return signToken(collection, record, "auth", { ttl, refreshable });
}

/** Unverified claims, as PB's ParseUnverifiedJWT; {} for garbage. */
export function tokenClaims(token: string): Partial<TokenClaims> {
  try {
    const [, payload] = decode(token);
    return (payload ?? {}) as Partial<TokenClaims>;
  } catch {
    return {};
  }
}

export interface VerifiedToken {
  collection: CollectionConfig;
  /** The raw row, secrets included; callers strip them before exposing it. */
  row: Record<string, unknown>;
  claims: TokenClaims;
}

/** PB FindAuthRecordByToken: null on any invalid, expired or wrong-type token instead of throwing. */
export async function verifyToken(db: DatabaseSync, token: string, type: TokenType): Promise<VerifiedToken | null> {
  try {
    // Unverified decode only picks the record whose tokenKey completes the secret.
    const c = tokenClaims(token);
    if (c.type !== type || typeof c.id !== "string" || typeof c.collectionId !== "string") return null;
    const col = getCollection(c.collectionId);
    if (!col.auth) return null;
    const id = c.id;
    const sql = `SELECT * FROM ${quoteIdent(col.slug)} WHERE id = ?`;
    // Outside the store, so it opens its own db.query span: an authenticated request shows its user lookup.
    const row = traceQuery("SELECT", col.slug, sql, () => db.prepare(sql).get(id)) as
      | Record<string, unknown>
      | undefined;
    if (!row || typeof row.tokenKey !== "string") return null;
    await verify(token, await hmacKey(row.tokenKey, col.slug, type));
    return { collection: col, row, claims: c as TokenClaims };
  } catch {
    return null;
  }
}

/** Drops hidden auth columns so the principal can be serialized safely. */
export function publicAuthRecord(row: Record<string, unknown>): Doc {
  const { passwordHash: _p, tokenKey: _t, ...rest } = row;
  return rest as Doc;
}

export async function verifyAuthToken(db: DatabaseSync, token: string): Promise<AuthUser | null> {
  const v = await verifyToken(db, token, "auth");
  return v && { id: v.claims.id, collection: v.collection.slug, record: publicAuthRecord(v.row) };
}
