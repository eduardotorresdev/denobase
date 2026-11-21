import type { App } from "../app.ts";
import type { CollectionConfig } from "../core/types.ts";
import type { Store } from "../store/mod.ts";
import { notificationCollections } from "./collections.ts";
import { type NotificationAuthorize, notificationRoutes } from "./http.ts";
import { Notifications, type NotificationsOptions } from "./registry.ts";
import type { Provider } from "./types.ts";
import { WhatsAppWebProvider } from "./whatsapp/provider.ts";
import { EmailProvider } from "./email/provider.ts";
import { service, type ServiceHandle } from "../services/handle.ts";
import type { NotificationMessage } from "./types.ts";
import type { NotificationRecord } from "./registry.ts";

export * from "./types.ts";
export * from "./collections.ts";
export { type NotificationRecord, Notifications, type NotificationsOptions } from "./registry.ts";
export { type NotificationAction, type NotificationAuthorize, notificationRoutes } from "./http.ts";
export {
  mergeContacts,
  quotedOf,
  receiptOf,
  toContent,
  toJid,
  toReply,
  WHATSAPP_WEB,
  type WhatsAppContact,
  type WhatsAppGroup,
  type WhatsAppMe,
  type WhatsAppReply,
  type WhatsAppWebOptions,
  WhatsAppWebProvider,
} from "./whatsapp/provider.ts";
export { type StoreAuthState, useStoreAuthState } from "./whatsapp/auth_state.ts";
export { EMAIL, EmailProvider } from "./email/provider.ts";

/** Native collections of the module; the consumer registers them (registerCollections) before migrate create. */
export const collections: CollectionConfig[] = notificationCollections;

export interface RegisterNotificationsOptions extends NotificationsOptions {
  /** Providers built over the app's store; default is WhatsApp Web alone. */
  providers?: (store: Store) => Provider[];
  /** Also registers an EmailProvider (id `email`) over app.mailer, so e-mails go through the same send log. */
  email?: boolean;
  /** Who may call /api/notifications/*; default superusers only. */
  authorize?: NotificationAuthorize;
}

/**
 * The serve's notifications as a long service: a job in a worker sends through it (`notificationsService.send(msg)`),
 * the serve's providers (a WhatsApp session) deliver. On the serve itself the call is direct.
 */
export type NotificationsMethods = {
  send(input: NotificationMessage, opts?: { maxAttempts?: number }): Promise<NotificationRecord>;
  retry(id: string): Promise<NotificationRecord>;
};

export const notificationsService: ServiceHandle<NotificationsMethods> = service<NotificationsMethods>(
  "notifications",
);

/**
 * Plugs notifications into an app (call it in beforeServe, or in the setup): on the serve, providers registered and
 * started when enabled, REST routes mounted, the `notifications` service provided, every provider stopped on
 * app.terminate(). In an executor, worker or mcp nothing starts (one WhatsApp session, on the serve): the returned
 * registry's send and retry go to the serve through the queue.
 */
export async function register(app: App, opts: RegisterNotificationsOptions = {}): Promise<Notifications> {
  if (app.role === "executor" || app.role === "worker" || app.role === "mcp") {
    const remote = notificationsService.on(app);
    return new Proxy({} as Notifications, {
      get: (_t, p) => {
        if (p === "send") return (m: NotificationMessage, o?: { maxAttempts?: number }) => remote.send(m, o);
        if (p === "retry") return (id: string) => remote.retry(id);
        if (p === "then") return undefined;
        return () => {
          throw new Error(`notifications.${String(p)} runs on the serve only (here: ${app.role})`);
        };
      },
    });
  }
  const n = new Notifications(app.store, opts);
  app.onTerminate(() => n.stop());
  notificationRoutes(app.http, app.store, n, opts.authorize);
  const providers = opts.providers?.(app.store) ?? [new WhatsAppWebProvider(app.store)];
  for (const p of providers) await n.register(p);
  if (opts.email) await n.register(new EmailProvider(() => app.mailer));
  // Not a singleton: every serve can deliver (the providers' own session state decides who connects).
  await notificationsService.provide(app, { send: (m, o) => n.send(m, o), retry: (id) => n.retry(id) }, {
    singleton: false,
  });
  return n;
}
