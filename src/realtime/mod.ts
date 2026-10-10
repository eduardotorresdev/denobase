import { traced } from "../telemetry/instrument/child.ts";
import { SpanKind } from "../telemetry/span.ts";
import type { AuthUser, Doc, Req } from "../core/types.ts";
import { afterCommit, tx } from "../core/db.ts";
import { reinsertRow } from "../store/sqlite.ts";

/** Thrown to roll back the transaction that briefly restores a row deleted elsewhere. */
const ROLLBACK = new Error("rollback");
import type { Services } from "../http/services.ts";
import { onRecordEvent, type RecordEvent } from "../engine/events.ts";
import { collectionId } from "../core/registry.ts";
import type { Store } from "../store/mod.ts";

/** PB realtime: 5 min without a message closes the stream; 30 min caps any connection. */
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

/** PB tools/subscriptions SubscriptionOptions, parsed from a subscription's ?options= JSON. */
export interface SubscriptionOptions {
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface Client {
  id: string;
  /** Remote IP at connect; a subscribe from another IP is refused (PB's clientId bruteforce precaution). */
  ip: string;
  auth: AuthUser | null;
  /** tokenKey of auth when it was set: a different one later (password change) drops the client's auth. */
  tokenKey?: string;
  subscriptions: Map<string, SubscriptionOptions>;
  /** Per-client values a subscribe hook keeps for the disconnect hook (PB client.Set/Get). */
  data: Map<string, unknown>;
  send(name: string, data: string): void;
  close(): void;
}

/** Who of the subscribed clients receives a published message; req is the client's, with its own access. */
export type TopicAccess = (args: { auth: AuthUser | null; req: Req }) => boolean | Promise<boolean>;

export interface PublishOptions {
  /** Defaults to any authenticated client: a custom topic carries domain data, so guests opt in explicitly. */
  access?: TopicAccess;
}

/**
 * PB OnRealtimeSubscribeRequest: runs before the subscriptions replace the client's; throwing (an ApiError) refuses
 * the whole request with that error and leaves the subscriptions as they were. `subscriptions` is the request as
 * sent; `topics` holds its non-empty topics, in order.
 */
export type SubscribeHook = (
  e: { client: Client; auth: AuthUser | null; req: Req; subscriptions: string[]; topics: string[] },
) => void | Promise<void>;

/** A subscribe hook that only checks the requested topics. */
export type SubscribeGuard = SubscribeHook;

/** PB OnRealtimeConnectRequest after e.Next(): the SSE connection of client ended (reader gone or timeout). */
export type DisconnectHook = (e: { client: Client }) => void | Promise<void>;

const authenticated: TopicAccess = ({ auth }) => !!auth;

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** PB security.RandomString(40). */
function clientId(): string {
  const b = crypto.getRandomValues(new Uint8Array(40));
  return Array.from(b, (x) => ALNUM[x % ALNUM.length]).join("");
}

/** PB: any-typed option values become strings; header names snake_case ("X-Token" -> "x_token"). */
export function parseSubscription(sub: string): SubscriptionOptions {
  const out: SubscriptionOptions = { query: {}, headers: {} };
  const q = sub.indexOf("?");
  if (q < 0) return out;
  const raw = new URLSearchParams(sub.slice(q + 1)).get("options");
  if (!raw) return out;
  let parsed: { query?: Record<string, unknown>; headers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const str = (
    v: unknown,
  ) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  for (const [k, v] of Object.entries(parsed?.query ?? {})) out.query[k] = str(v);
  for (const [k, v] of Object.entries(parsed?.headers ?? {})) {
    out.headers[k.replace(/[-\s]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()] = str(v);
  }
  return out;
}

export function isSameAuth(a: AuthUser | null, b: AuthUser | null): boolean {
  if (!a) return !b;
  return !!b && a.id === b.id && a.collection === b.collection;
}

const encoder = new TextEncoder();

/** One SSE message in PB's exact framing: id is always the client id. */
function frame(clientId: string, name: string, data: string): Uint8Array {
  return encoder.encode(`id:${clientId}\nevent:${name}\ndata:${data}\n\n`);
}

/**
 * The subscriptions broker of one app (one db). Listens to record events only while it has clients, and builds
 * each message through the engine as that client, so read rules, afterRead hooks, expand and fields match REST.
 */
export class Realtime {
  readonly clients: Map<string, Client> = new Map();
  private unlisten?: () => void;
  private readonly subscribeHooks: SubscribeHook[] = [];
  private readonly disconnectHooks: DisconnectHook[] = [];

  private readonly db;

  constructor(private readonly store: Store, private readonly s: Services) {
    this.db = store.db;
  }

  /** GET /api/realtime: registers a client and streams PB_CONNECT, then its messages. */
  connect(ip: string): Response {
    const id = clientId();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let max: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (!this.clients.has(id)) return;
      clearTimeout(idle);
      clearTimeout(max);
      this.unregister(id);
      try {
        controller.close();
      } catch { /* already closed by the reader */ }
      void this.disconnected(client);
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(close, IDLE_TIMEOUT_MS);
    };
    const client: Client = {
      id,
      ip,
      auth: null,
      subscriptions: new Map(),
      data: new Map(),
      send: (name, data) => {
        try {
          controller.enqueue(frame(id, name, data));
          resetIdle();
        } catch {
          close();
        }
      },
      close,
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        this.register(client);
        c.enqueue(frame(id, "PB_CONNECT", JSON.stringify({ clientId: id })));
        resetIdle();
        max = setTimeout(close, MAX_TIMEOUT_MS);
      },
      cancel: close,
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  }

  private register(c: Client): void {
    this.clients.set(c.id, c);
    this.unlisten ??= onRecordEvent({
      changed: (e) => this.changed(e),
      deleting: (e) => this.deleting(e),
      // Clients connected here hear the writes of every thread (the job worker, the other HTTP isolates).
      remote: true,
      deletedElsewhere: (e) => this.deletedElsewhere(e),
    });
  }

  private unregister(id: string): void {
    this.clients.delete(id);
    if (!this.clients.size) {
      this.unlisten?.();
      this.unlisten = undefined;
    }
  }

  /** Adds a hook to every subscribe request (PB OnRealtimeSubscribeRequest), in registration order, once. */
  onSubscribe(fn: SubscribeHook): void {
    if (!this.subscribeHooks.includes(fn)) this.subscribeHooks.push(fn);
  }

  /** Adds a hook to every closed connection (PB OnRealtimeConnectRequest after Next); a failing one is logged. */
  onDisconnect(fn: DisconnectHook): void {
    this.disconnectHooks.push(fn);
  }

  /** POST /api/realtime after validation: runs the subscribe hooks as the requester, then sets the subscriptions. */
  async subscribe(client: Client, auth: AuthUser | null, subs: string[]): Promise<void> {
    if (this.subscribeHooks.length) {
      const req = this.s.makeReq(this.store, auth);
      const topics = subs.filter((t) => t !== "");
      for (const fn of this.subscribeHooks) await fn({ client, auth, req, subscriptions: [...subs], topics });
    }
    this.setSubscriptions(client, auth, subs);
  }

  private async disconnected(client: Client): Promise<void> {
    for (const fn of this.disconnectHooks) {
      try {
        await fn({ client });
      } catch (err) {
        console.error("realtime disconnect hook failed", err);
      }
    }
  }

  /** Sets auth (guest -> auth only) and replaces the subscriptions. */
  setSubscriptions(client: Client, auth: AuthUser | null, subs: string[]): void {
    client.auth = auth;
    client.tokenKey = auth ? this.s.credentials(this.db, auth.collection, { id: auth.id })?.tokenKey : undefined;
    client.subscriptions.clear();
    for (const s of subs) if (s !== "") client.subscriptions.set(s, parseSubscription(s));
  }

  /**
   * Sends data to every client subscribed to exactly `topic` that `access` lets in (PB's subscription check + send). The event name is the topic. Inside a transaction it leaves only after the
   * commit, like record events, so a rolled-back write never announces itself. Resolves with how many clients got it.
   */
  publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<number> {
    if (!topic) return Promise.reject(new Error("realtime.publish: empty topic"));
    return traced("realtime.publish", {
      kind: SpanKind.producer,
      attributes: { "messaging.system": "denobase.realtime", "messaging.destination.name": topic },
    }, async (span) => {
      const n = await this.#publish(topic, data, opts);
      span?.setAttribute("realtime.clients", n);
      return n;
    });
  }

  async #publish(topic: string, data: unknown, opts: PublishOptions): Promise<number> {
    const payload = JSON.stringify(data ?? null);
    const access = opts.access ?? authenticated;
    const targets: Client[] = [];
    for (const c of this.clients.values()) {
      if (!c.subscriptions.has(topic)) continue;
      if (await access({ auth: c.auth, req: this.s.makeReq(this.store, c.auth) })) targets.push(c);
    }
    afterCommit(this.db, () => {
      for (const c of targets) if (this.clients.has(c.id)) c.send(topic, payload);
    });
    return targets.length;
  }

  /** PB Client.Subscriptions(prefix): "?" closes the topic, so "users/*?" never matches "users/*x". */
  private matching(c: Client, prefixes: string[]): [string, SubscriptionOptions][] {
    return [...c.subscriptions].filter(([s]) => prefixes.some((p) => (s + "?").startsWith(p)));
  }

  /** The record as client sees it through sub's options, or null when rules or the sub's filter hide it. */
  private async render(e: RecordEvent, c: Client, opts: SubscriptionOptions): Promise<Doc | null> {
    try {
      const r = await this.s.find({
        collection: e.collection.slug,
        req: this.s.makeReq(this.store, c.auth),
        where: { id: { equals: e.id } },
        filter: opts.query.filter || undefined,
        // PB realtimeCanAccessRecord mocks the request: GET, the subscription's query and headers.
        requestInfo: { context: "realtime", method: "GET", query: opts.query, headers: opts.headers },
        expand: opts.query.expand || undefined,
        fields: opts.query.fields || undefined,
        perPage: 1,
      });
      return r.items[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Messages for every client subscribed to the record, built now (for a delete, while the row still exists). */
  private async messages(e: RecordEvent): Promise<[Client, string, string][]> {
    if (e.db !== this.db) return [];
    // PB matches both the collection name and its id, and keeps the bare "name" topic for backward compatibility.
    const prefixes = [e.collection.slug, collectionId(e.collection)].flatMap((
      n,
    ) => [`${n}/${e.id}?`, `${n}/*?`, `${n}?`]);
    const out: [Client, string, string][] = [];
    for (const c of this.clients.values()) {
      for (const [sub, opts] of this.matching(c, prefixes)) {
        const record = await this.render(e, c, opts);
        if (record) out.push([c, sub, JSON.stringify({ record, action: e.action })]);
      }
    }
    return out;
  }

  private async changed(e: RecordEvent): Promise<void> {
    if (e.db !== this.db) return;
    if (e.action === "update" && e.collection.auth) this.refreshAuth(e);
    for (const [c, name, data] of await this.messages(e)) c.send(name, data);
  }

  private async deleting(e: RecordEvent): Promise<(() => void) | void> {
    if (e.db !== this.db) return;
    const msgs = await this.messages(e);
    return () => {
      if (e.collection.auth) this.dropAuth(e);
      for (const [c, name, data] of msgs) c.send(name, data);
    };
  }

  /**
   * A delete another thread committed: PB checks access against the row before it goes, so the row it carried is put
   * back for the length of a transaction that rolls back, the messages are built against it, and it is gone again.
   */
  private async deletedElsewhere(e: RecordEvent): Promise<void> {
    if (e.db !== this.db || !e.row) return;
    if (!this.clients.size) return;
    let msgs: [Client, string, string][] = [];
    try {
      await tx(this.db, async () => {
        reinsertRow(this.db, e.collection.slug, e.row!);
        msgs = await this.messages(e);
        throw ROLLBACK;
      });
    } catch (err) {
      // A row that cannot come back (its parent went in the same cascade) has no one left to tell.
      if (err !== ROLLBACK) return;
    }
    if (e.collection.auth) this.dropAuth(e);
    for (const [c, name, data] of msgs) c.send(name, data);
  }

  /** PB realtimeUpdateClientsAuth: a new tokenKey (password reset) unsets the auth, otherwise the record refreshes. */
  private refreshAuth(e: RecordEvent): void {
    const cred = this.s.credentials(this.db, e.collection.slug, { id: e.id });
    for (const c of this.clients.values()) {
      if (!c.auth || c.auth.id !== e.id || c.auth.collection !== e.collection.slug) continue;
      if (!cred || cred.tokenKey !== c.tokenKey) {
        c.auth = null;
        c.tokenKey = undefined;
      }
    }
  }

  private dropAuth(e: RecordEvent): void {
    for (const c of this.clients.values()) {
      if (c.auth?.id === e.id && c.auth.collection === e.collection.slug) {
        c.auth = null;
        c.tokenKey = undefined;
      }
    }
  }
}
