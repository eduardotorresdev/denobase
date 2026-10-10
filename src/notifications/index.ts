import type { App } from "../app.ts";
import type { CollectionConfig } from "../core/types.ts";
import type { Store } from "../store/mod.ts";
import { notificationCollections } from "./collections.ts";
import { type NotificationAuthorize, notificationRoutes } from "./http.ts";
import { Notifications, type NotificationsOptions } from "./registry.ts";
import type { Provider } from "./types.ts";
import { WhatsAppWebProvider } from "./whatsapp/provider.ts";

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

/** Native collections of the module; the consumer registers them (registerCollections) before migrate create. */
export const collections: CollectionConfig[] = notificationCollections;

export interface RegisterNotificationsOptions extends NotificationsOptions {
  /** Providers built over the app's store; default is WhatsApp Web alone. */
  providers?: (store: Store) => Provider[];
  /** Who may call /api/notifications/*; default superusers only. */
  authorize?: NotificationAuthorize;
}

/**
 * Plugs notifications into an app (call it in beforeServe): providers registered and started when enabled, REST
 * routes mounted, and every provider stopped on app.terminate(). Consumers send through the returned registry.
 */
export async function register(app: App, opts: RegisterNotificationsOptions = {}): Promise<Notifications> {
  const n = new Notifications(app.store, opts);
  app.onTerminate(() => n.stop());
  notificationRoutes(app.http, app.store, n, opts.authorize);
  const providers = opts.providers?.(app.store) ?? [new WhatsAppWebProvider(app.store)];
  for (const p of providers) await n.register(p);
  return n;
}
