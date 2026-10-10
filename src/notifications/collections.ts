import type { CollectionConfig } from "../core/types.ts";
import { notificationProvidersCollection, notificationsCollection, whatsappAuthCollection } from "./schema.ts";

export { NOTIFICATION_STATUS, type NotificationStatus } from "./schema.ts";

/** Per-provider config; superusers only (the engine bypass), like every "_" collection. */
export const notificationProviders: CollectionConfig = notificationProvidersCollection;
/** Send log: one row per message, updated by attempts and receipts. */
export const notifications: CollectionConfig = notificationsCollection;
/** Baileys session (creds and signal keys), one row per key, so it survives restarts in the app's db. */
export const whatsappAuth: CollectionConfig = whatsappAuthCollection;

/** In FK order, for registerCollections. */
export const notificationCollections: CollectionConfig[] = [notificationProviders, notifications, whatsappAuth];
