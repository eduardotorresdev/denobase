import { currentCall } from "../services/manager.ts";
import { traced } from "../telemetry/instrument/child.ts";
import { SpanKind } from "../telemetry/span.ts";
import { badRequest, notFound } from "../core/errors.ts";
import type { Store } from "../store/mod.ts";
import { tx } from "../core/db.ts";
import {
  notificationProvidersCollection as notificationProviders,
  notificationsCollection as notifications,
  type NotificationStatus,
} from "./schema.ts";
import {
  type InboundMessage,
  messageSchema,
  type NotificationMessage,
  type Provider,
  type ProviderEvents,
  type ProviderStatus,
  type ReceiptStatus,
} from "./types.ts";

/** A row of `_notifications` as the store returns it (PB zero values). */
export interface NotificationRecord {
  id: string;
  created: string;
  updated: string;
  provider: string;
  channel: string;
  to: string;
  text: string;
  /** Media metadata only; the payload is not logged. */
  media: unknown;
  status: NotificationStatus;
  error: string;
  attempts: number;
  externalId: string;
}

export interface NotificationsOptions {
  /** Attempts per send before the row is marked failed; default 3. */
  maxAttempts?: number;
  /** Delay before attempt n (1-based retries); default 1s, 4s, 9s... Tests pass () => 0. */
  backoffMs?: (attempt: number) => number;
}

type Listener<T> = (v: T) => void | Promise<void>;

/**
 * The provider registry and send log: every message goes through send(), which logs it in _notifications,
 * retries the provider and records the outcome; receipts and inbound messages flow back through it.
 */
export class Notifications {
  readonly #providers = new Map<string, Provider>();
  readonly #inbound = new Set<Listener<InboundMessage>>();
  readonly #statusListeners = new Set<Listener<{ provider: string; status: ProviderStatus }>>();
  readonly #maxAttempts: number;
  readonly #backoff: (attempt: number) => number;

  constructor(private readonly store: Store, opts: NotificationsOptions = {}) {
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#backoff = opts.backoffMs ?? ((n) => n * n * 1000);
  }

  /** Adds a provider and starts it when its _notification_providers row says enabled. */
  async register(provider: Provider): Promise<void> {
    if (this.#providers.has(provider.id)) {
      throw new Error(`notifications: provider "${provider.id}" already registered`);
    }
    this.#providers.set(provider.id, provider);
    if (await this.isEnabled(provider.id)) await provider.start?.(this.#events());
  }

  get(id: string): Provider {
    const p = this.#providers.get(id);
    if (!p) throw notFound(`Unknown notification provider "${id}".`);
    return p;
  }

  list(): { id: string; channels: readonly string[]; status: ProviderStatus }[] {
    return [...this.#providers.values()].map((p) => ({ id: p.id, channels: p.channels, status: p.status() }));
  }

  async isEnabled(id: string): Promise<boolean> {
    const row = await this.#configRow(id);
    // Off until a superuser turns it on: an unpaired WhatsApp would otherwise loop on QR codes from boot.
    return !!row?.enabled;
  }

  async config(id: string): Promise<Record<string, unknown>> {
    return ((await this.#configRow(id))?.config as Record<string, unknown> | undefined) ?? {};
  }

  /** Upserts the provider's config row; enabling starts it, disabling stops it. */
  async configure(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void> {
    const p = this.get(id);
    const before = await this.isEnabled(id);
    const rows = this.store.collection(notificationProviders);
    const row = await this.#configRow(id);
    if (row) await rows.update(row.id, patch);
    else await rows.create({ provider: id, enabled: patch.enabled ?? true, config: patch.config ?? {} });
    const after = await this.isEnabled(id);
    if (before && !after) await p.stop?.();
    if (!before && after) await p.start?.(this.#events());
  }

  /**
   * Validates, logs as queued, then tries the provider up to maxAttempts (`opts.maxAttempts` overrides it for this
   * send: a caller under a deadline that reports the failure itself asks for 1); resolves with the final row.
   */
  async send(input: NotificationMessage, opts: { maxAttempts?: number } = {}): Promise<NotificationRecord> {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid message.");
    const msg = parsed.data;
    const provider = this.get(msg.provider);
    const email = provider.channels[0] === "email";
    if (email && (!msg.subject?.trim() || msg.media)) {
      throw badRequest("An e-mail needs a subject and takes no media.");
    }
    const media = msg.media ? { ...msg.media, data: undefined } : null;
    // Called as a service from a job: the call's key. A retried job gets the row of its first send back, sent again
    // only when that one failed or was left queued by a serve that died before sending (the effect never happened).
    const idem = currentCall()?.idem ?? "";
    const max = Math.max(1, opts.maxAttempts ?? this.#maxAttempts);
    const fresh = {
      idem,
      provider: provider.id,
      channel: provider.channels[0],
      to: msg.to,
      // An e-mail logs its subject: the body is HTML (and may carry a private link), so it is not kept, like inline
      // media; retry() therefore cannot resend one.
      text: email ? msg.subject! : msg.text ?? "",
      media,
      status: "queued" as const,
      attempts: 0,
    };
    for (;;) {
      const r = await this.#reserve(idem, fresh);
      if ("done" in r) return r.done;
      if ("mine" in r) return await this.#attempt(r.mine, provider, msg, max);
      // Another process (or this one) is sending the same call: its outcome is this one's.
      await delay(SEND_POLL_MS);
    }
  }

  /**
   * Takes the call's row for sending, in one IMMEDIATE transaction (two serves never both take it): a sent row is the
   * answer; a row someone holds under a live reservation is waited for; a failed row, a queued one nobody holds, or a
   * reservation that lapsed (its serve died) is taken. Without a call key, a new row is created and taken.
   */
  #reserve(
    idem: string,
    fresh: { provider: string; channel: string; to: string; status: "queued" } & Record<string, unknown>,
  ): Promise<{ done: NotificationRecord } | { mine: NotificationRecord } | { wait: true }> {
    const rows = this.store.collection(notifications);
    return tx(this.store.db, async () => {
      const now = Date.now();
      const hold = { status: "queued" as const, sender: this.#token, sendUntil: now + SEND_LEASE_MS };
      const prior = idem ? await rows.query().where("idem", "equals", idem).first() : undefined;
      if (!prior) return { mine: (await rows.create({ ...fresh, ...hold })) as NotificationRecord };
      if (prior.status !== "failed" && prior.status !== "queued") return { done: prior as NotificationRecord };
      if (prior.status === "queued" && prior.sender && Number(prior.sendUntil) > now) return { wait: true as const };
      return { mine: (await rows.update(prior.id, hold)) as NotificationRecord };
    });
  }

  /** This process's reservation token. */
  readonly #token = crypto.randomUUID().slice(0, 18);

  /** Sends a failed row again; media sent by url retries, base64 media was never logged and cannot. */
  async retry(id: string): Promise<NotificationRecord> {
    const row = await this.store.collection(notifications).get(id);
    if (row.status !== "failed") throw badRequest("Only failed notifications can be retried.");
    if (row.channel === "email") throw badRequest("An e-mail's body is not kept; send it again.");
    const media = row.media as NotificationMessage["media"] | null;
    if (media && !media.url) throw badRequest("Media sent inline is not kept; send it again.");
    const msg: NotificationMessage = {
      provider: row.provider,
      to: row.to,
      text: row.text || undefined,
      media: media ?? undefined,
    };
    const mine = await tx(this.store.db, async () => {
      const r = await this.store.collection(notifications).get(id);
      if (r.status !== "failed") throw badRequest("Only failed notifications can be retried.");
      return await this.store.collection(notifications).update(id, {
        status: "queued",
        sender: this.#token,
        sendUntil: Date.now() + SEND_LEASE_MS,
      });
    });
    return await this.#attempt(mine as NotificationRecord, this.get(row.provider), msg);
  }

  /** Inbound messages of every provider; returns the unsubscribe. */
  onInbound(fn: Listener<InboundMessage>): () => void {
    this.#inbound.add(fn);
    return () => this.#inbound.delete(fn);
  }

  onStatus(fn: Listener<{ provider: string; status: ProviderStatus }>): () => void {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  /** Stops every provider; wired to app.onTerminate. */
  async stop(): Promise<void> {
    for (const p of this.#providers.values()) await p.stop?.();
  }

  /**
   * Sends the reserved row, keeping its reservation alive meanwhile. Recording the outcome is apart from sending it: a
   * write that fails (a busy db) after the provider accepted is retried as a write, never by sending again.
   */
  async #attempt(
    row: NotificationRecord,
    p: Provider,
    msg: NotificationMessage,
    maxAttempts = this.#maxAttempts,
  ): Promise<NotificationRecord> {
    const done = Number(row.attempts ?? 0);
    const renew = setInterval(() => {
      void this.#ifMine(row.id, { sendUntil: Date.now() + SEND_LEASE_MS }).catch(() => {});
    }, SEND_LEASE_MS / 3);
    try {
      let error = "";
      for (let n = 1; n <= maxAttempts; n++) {
        if (n > 1) await delay(this.#backoff(n - 1));
        // A hold lost while frozen (or in the backoff): the serve that took it sends; this one must not send again.
        const cur = await this.store.collection(notifications).get(row.id).catch(() => null);
        if (!cur || cur.sender !== this.#token) return (cur ?? row) as NotificationRecord;
        let externalId: string | undefined;
        try {
          ({ externalId } = await traced("notification.send", {
            kind: SpanKind.client,
            attributes: {
              "notification.provider": p.id,
              "notification.channel": p.channels[0],
              "notification.attempt": n,
            },
          }, () => p.send(msg)));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          continue;
        }
        return await this.#record(row.id, {
          status: "sent",
          attempts: done + n,
          externalId: externalId ?? "",
          error: "",
          sender: "",
          sendUntil: 0,
        });
      }
      return await this.#record(row.id, {
        status: "failed",
        attempts: done + maxAttempts,
        error: error.slice(0, 2000),
        sender: "",
        sendUntil: 0,
      });
    } finally {
      clearInterval(renew);
    }
  }

  /** Writes an outcome, retrying the write alone (a busy db); the send it records is never repeated for it. */
  async #record(
    id: string,
    data: Partial<NotificationRecord> & { sender: string; sendUntil: number },
  ): Promise<NotificationRecord> {
    for (let i = 0;; i++) {
      try {
        const r = await this.#ifMine(id, data);
        // Another serve took the reservation while this one was frozen past it: its outcome is the one kept.
        return r ?? (await this.store.collection(notifications).get(id)) as NotificationRecord;
      } catch (err) {
        if (i >= RECORD_TRIES - 1) throw err;
        await delay(RECORD_RETRY_MS * (i + 1));
      }
    }
  }

  /**
   * Updates the row only while this registry still holds its reservation: a serve frozen past SEND_LEASE_MS wakes up
   * with a renewal or an outcome to write, and must not take over a reservation another serve has since claimed.
   * Null when it is no longer ours.
   */
  #ifMine(
    id: string,
    data: Partial<NotificationRecord> & { sender?: string; sendUntil?: number },
  ): Promise<NotificationRecord | null> {
    const rows = this.store.collection(notifications);
    return tx(this.store.db, async () => {
      const cur = await rows.get(id).catch(() => null);
      if (!cur || cur.sender !== this.#token) return null;
      return (await rows.update(id, data)) as NotificationRecord;
    });
  }

  async #configRow(id: string) {
    return await this.store.collection(notificationProviders).query().where("provider", "equals", id).first();
  }

  #events(): ProviderEvents {
    return {
      receipt: (provider, externalId, status) => this.#receipt(provider, externalId, status),
      inbound: async (msg) => {
        for (const fn of this.#inbound) {
          try {
            await fn(msg);
          } catch (err) {
            console.error("notifications inbound listener:", err);
          }
        }
      },
      status: (provider, status) => {
        for (const fn of this.#statusListeners) void fn({ provider, status });
      },
    };
  }

  /** Receipts only move forward (sent -> delivered -> read); a late "delivered" never undoes "read". */
  async #receipt(provider: string, externalId: string, status: ReceiptStatus): Promise<void> {
    if (!externalId) return;
    const rows = this.store.collection(notifications);
    const row = await rows.query().where("provider", "equals", provider).where("externalId", "equals", externalId)
      .first();
    if (!row) return;
    const rank = { queued: 0, failed: 0, sent: 1, delivered: 2, read: 3 } as const;
    if (status === "failed") {
      if (row.status !== "failed") await rows.update(row.id, { status: "failed", error: "provider reported failure" });
      return;
    }
    if (rank[status] > rank[row.status as keyof typeof rank]) await rows.update(row.id, { status });
  }
}

/** How long a send reservation lasts unrenewed: a serve that died mid-send frees its row after it. */
const SEND_LEASE_MS = 30_000;
/** How often a duplicate call checks the row another sender holds. */
const SEND_POLL_MS = 200;
const RECORD_TRIES = 10;
const RECORD_RETRY_MS = 100;

const delay = (ms: number) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
