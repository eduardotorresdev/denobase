import type { S3Config, Settings } from "./model.ts";

const s3 = (): S3Config => ({
  enabled: false,
  bucket: "",
  region: "",
  endpoint: "",
  accessKey: "",
  secret: "",
  forcePathStyle: false,
});

/** PB newDefaultSettings. */
export function defaultSettings(): Settings {
  return {
    superuserIPs: [],
    smtp: {
      enabled: false,
      port: 587,
      host: "smtp.example.com",
      username: "",
      password: "",
      authMethod: "",
      tls: false,
      localName: "",
    },
    backups: { cron: "", cronMaxKeep: 3, s3: s3() },
    s3: s3(),
    meta: {
      accentColor: "#1055c9",
      appName: "Acme",
      appURL: "http://localhost:8090",
      senderName: "Support",
      senderAddress: "support@example.com",
      hideControls: false,
      timezone: "UTC",
    },
    rateLimits: {
      rules: [
        { label: "*:auth", audience: "", duration: 3, maxRequests: 2 },
        { label: "*:create", audience: "", duration: 5, maxRequests: 20 },
        { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
        { label: "/api/", audience: "", duration: 10, maxRequests: 300 },
      ],
      excludedIPs: [],
      enabled: false,
    },
    trustedProxy: { headers: [], useLeftmostIP: false },
    batch: { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 },
    logs: { maxDataSize: 0, maxDays: 5, minLevel: 0, logIP: true, logAuthId: false },
    traces: {
      enabled: true,
      sampleRatio: 1,
      maxDays: 7,
      minDurationMs: 0,
      slowMs: 1000,
      maxSpansPerTrace: 500,
      recordDbText: true,
      trustTraceparent: false,
      propagateHosts: [],
    },
    oauth: {
      enabled: true,
      allowedCollections: [],
      defaultCollection: "users",
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86400,
      codeTTL: 60,
      sessionTTL: 12 * 3600,
      dcrEnabled: true,
      cimdEnabled: true,
      cimdAllowDomains: [],
      cimdDenyDomains: [],
      allowLoopback: true,
      allowedRedirectHosts: [],
      rememberConsent: true,
    },
  };
}

export const DEFAULT_SETTINGS: Settings = defaultSettings();

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type SettingsPatch = DeepPartial<Settings>;
