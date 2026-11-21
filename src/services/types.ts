import type { App } from "../app.ts";

// deno-lint-ignore no-explicit-any
export type Methods = Record<string, (...args: any[]) => any>;

/**
 * A long service's state, after supervisord's: starting until it has stayed up `startSecs`, running, backoff between
 * restarts, fatal once the restarts in a row ran out (only a manual start leaves it), stopping/stopped, and standby
 * for a singleton another serve holds.
 */
export type ServiceStatus = "stopped" | "starting" | "running" | "backoff" | "stopping" | "fatal" | "standby";

/** What a service's start gets: its stop signal and the way to report that it died (a dropped session). */
export interface ServiceCtx {
  app: App;
  /** Aborted when the manager stops it (stop, restart, terminate, a singleton lease lost). */
  signal: AbortSignal;
  /** It died: the manager restarts it under the restart policy. */
  crashed(reason?: unknown): void;
  /** It ended cleanly by itself: restarted only under `restart: "always"`. */
  exited(): void;
}

/** What a serve provides: the methods, plus the lifecycle (start/stop) and a status shown in the admin. */
export type ServiceImpl<M extends Methods> = M & {
  /** Resolves once it is up (or rejects: a failed start). Keep running work on ctx, not in the promise. */
  start?: (ctx: ServiceCtx) => unknown;
  stop?: () => unknown;
  status?: () => unknown;
};

export type RestartPolicy = "always" | "on-failure" | "never";

export interface ProvideOptions {
  /** Started when provided (default true); false leaves it stopped until a start from the admin or the API. */
  autostart?: boolean;
  /** One serve at a time (a WhatsApp session); the others stay in standby. Default true. */
  singleton?: boolean;
  /** After a crash: default on-failure. */
  restart?: RestartPolicy;
  /** How long it must stay up to count as running (a crash before it is a failed start). Default 1 s. */
  startSecs?: number;
  /** The first wait before a restart, doubled per failed start; default 1 s, at most maxBackoffMs (60 s). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Crashes in a row before fatal. Default 5. */
  maxRetries?: number;
  /** A run that stays up this long resets the crash count. Default 60 s. */
  stableSecs?: number;
}

/** One service on one node, as the admin sees it. */
export interface ServiceState {
  name: string;
  node: string;
  state: ServiceStatus;
  /** When it entered this state. */
  since: number;
  /** When the current run started (uptime while running). */
  startedAt: number | null;
  /** Crashes in a row (reset by a run that stayed up stableSecs). */
  retries: number;
  lastExitAt: number | null;
  lastExitReason: string | null;
  singleton: boolean;
  detail?: unknown;
  /** The node's socket while the service runs there (where other processes call it). */
  addr?: string | null;
  /** Calls served on that node since it started, failed ones, mean time (in memory there). */
  calls?: number;
  errors?: number;
  avgMs?: number;
  /** The node's last beat; a row whose beat is old belongs to a dead node. */
  beat?: number;
  alive?: boolean;
}

export interface CallOptions {
  /** How long the caller waits; past it the caller gets `service_deadline`. */
  deadlineMs?: number;
  /** Replaces the idempotency key (a business id). */
  idem?: string;
}

export interface ServiceOptions<M extends Methods> {
  /** Per method: false turns idempotency off (queries); every method is idempotent by default. */
  idempotent?: Partial<Record<keyof M, boolean>>;
  /** Default deadline of a call; 30 s. */
  deadlineMs?: number;
}
