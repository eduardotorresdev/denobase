import { traced } from "../telemetry/instrument/child.ts";
import { SpanKind } from "../telemetry/span.ts";
import { badRequest, notFound } from "../core/errors.ts";
import type { Store } from "../store/mod.ts";
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

  /** Validates, logs as queued, then tries the provider up to maxAttempts; resolves with the final row. */
  async send(input: NotificationMessage): Promise<NotificationRecord> {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid message.");
    const msg = parsed.data;
    const provider = this.get(msg.provider);
    const email = provider.channels[0] === "email";
    if (email && (!msg.subject?.trim() || msg.media)) {
      throw badRequest("An e-mail needs a subject and takes no media.");
    }
    const media = msg.media ? { ...msg.media, data: undefined } : null;
    const row = await this.store.collection(notifications).create({
      provider: provider.id,
      channel: provider.channels[0],
      to: msg.to,
      // An e-mail logs its subject: the body is HTML (and may carry a private link), so it is not kept, like inline
      // media; retry() therefore cannot resend one.
      text: email ? msg.subject! : msg.text ?? "",
      media,
      status: "queued",
      attempts: 0,
    });
    return await this.#attempt(row.id, provider, msg);
  }

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
    return await this.#attempt(row.id, this.get(row.provider), msg, row.attempts ?? 0);
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

  async #attempt(id: string, p: Provider, msg: NotificationMessage, done = 0): Promise<NotificationRecord> {
    const rows = this.store.collection(notifications);
    let error = "";
    for (let n = 1; n <= this.#maxAttempts; n++) {
      if (n > 1) await delay(this.#backoff(n - 1));
      try {
        const { externalId } = await traced("notification.send", {
          kind: SpanKind.client,
          attributes: {
            "notification.provider": p.id,
            "notification.channel": p.channels[0],
            "notification.attempt": n,
          },
        }, () => p.send(msg));
        return await rows.update(id, { status: "sent", attempts: done + n, externalId: externalId ?? "", error: "" });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    return await rows.update(id, { status: "failed", attempts: done + this.#maxAttempts, error: error.slice(0, 2000) });
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

const delay = (ms: number) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
