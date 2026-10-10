/**
 * The module's collections with their literal types, for the module's own typed store calls. The public names
 * (collections.ts) are the same objects typed as CollectionConfig, which is what JSR documents.
 */
import { defineCollection } from "../core/define.ts";

const denyAll = { read: () => false, create: () => false, update: () => false, delete: () => false };

/** Per-provider config; superusers only (the engine bypass), like every "_" collection. */
export const notificationProvidersCollection = defineCollection({
  slug: "_notification_providers",
  fields: [
    { name: "provider", type: "text", required: true, unique: true },
    { name: "enabled", type: "checkbox" },
    { name: "config", type: "json" },
  ],
  access: denyAll,
});

export const NOTIFICATION_STATUS = ["queued", "sent", "delivered", "read", "failed"] as const;
export type NotificationStatus = typeof NOTIFICATION_STATUS[number];

/** Send log: one row per message, updated by attempts and receipts. */
export const notificationsCollection = defineCollection({
  slug: "_notifications",
  fields: [
    { name: "provider", type: "text", required: true },
    { name: "channel", type: "text", required: true },
    { name: "to", type: "text", required: true },
    { name: "text", type: "text", maxLength: 65536 },
    /** Media metadata only; the payload is not logged. */
    { name: "media", type: "json" },
    { name: "status", type: "select", options: [...NOTIFICATION_STATUS], required: true },
    { name: "error", type: "text", maxLength: 2000 },
    { name: "attempts", type: "number", integer: true, min: 0 },
    { name: "externalId", type: "text" },
  ],
  indexes: [{ fields: ["provider", "externalId"] }, { fields: ["status"] }],
  access: denyAll,
});

/** Baileys session (creds and signal keys), one row per key, so it survives restarts in the app's db. */
export const whatsappAuthCollection = defineCollection({
  slug: "_whatsapp_auth",
  fields: [
    { name: "session", type: "text", required: true },
    { name: "key", type: "text", required: true, maxLength: 512 },
    { name: "value", type: "json", hidden: true },
  ],
  indexes: [{ fields: ["session", "key"], unique: true }],
  access: denyAll,
});
