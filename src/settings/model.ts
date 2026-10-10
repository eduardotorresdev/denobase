/** PB's settings model, JSON keys included. */
export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  accessKey: string;
  secret: string;
  forcePathStyle: boolean;
}

export interface RateLimitRule {
  label: string;
  audience: string;
  duration: number;
  maxRequests: number;
}

import type { TraceSettings } from "../telemetry/buffer.ts";

/**
 * Denobase-only: the embedded OAuth authorization server of the MCP (src/oauth). Flat on purpose, so the admin UI
 * edits it like the other sections. Durations in seconds.
 */
export interface OAuthSettings {
  enabled: boolean;
  /** Auth collections that may authorize; always narrowed to the code's McpOptions.oauth.collections. Empty: all. */
  allowedCollections: string[];
  /**
   * The collection a request signs in against when /oauth/authorize carries no auth_collection. When it is not among
   * the collections that may authorize, the first of those is used.
   */
  defaultCollection: string;
  accessTokenTTL: number;
  /** Sliding: every rotation starts a new window. */
  refreshTokenTTL: number;
  codeTTL: number;
  /** The browser session of /oauth/* (cookie). */
  sessionTTL: number;
  /** Dynamic client registration (RFC 7591) at /oauth/register. */
  dcrEnabled: boolean;
  /** Client ID Metadata Documents: an https client_id fetched on demand. */
  cimdEnabled: boolean;
  cimdAllowDomains: string[];
  cimdDenyDomains: string[];
  /** http://localhost|127.0.0.1|[::1] redirects with any port (RFC 8252). */
  allowLoopback: boolean;
  /** Hosts an https redirect may point at; empty: any. */
  allowedRedirectHosts: string[];
  /** Skip the consent screen when the same user already granted the same client, resource and scopes. */
  rememberConsent: boolean;
}

export interface Settings {
  superuserIPs: string[];
  smtp: {
    enabled: boolean;
    port: number;
    host: string;
    username: string;
    password: string;
    authMethod: string;
    tls: boolean;
    localName: string;
  };
  backups: { cron: string; cronMaxKeep: number; s3: S3Config };
  s3: S3Config;
  meta: {
    accentColor: string;
    appName: string;
    appURL: string;
    senderName: string;
    senderAddress: string;
    hideControls: boolean;
    /** IANA name; crons run and the admin UI displays in it. Stored times stay UTC. */
    timezone: string;
  };
  rateLimits: { rules: RateLimitRule[]; excludedIPs: string[]; enabled: boolean };
  trustedProxy: { headers: string[]; useLeftmostIP: boolean };
  batch: { enabled: boolean; maxRequests: number; timeout: number; maxBodySize: number };
  logs: { maxDataSize: number; maxDays: number; minLevel: number; logIP: boolean; logAuthId: boolean };
  /** Denobase-only (PB has no tracing): native traces in the auxiliary db. */
  traces: TraceSettings;
  /** Denobase-only: OAuth for the MCP. */
  oauth: OAuthSettings;
}
