import { defineCollection } from "./define.ts";
import type { CollectionConfig } from "./types.ts";

/** Only superusers manage superusers; the engine bypass makes deny-all correct here. */
export const superusers: CollectionConfig = defineCollection({
  slug: "_superusers",
  auth: { otp: { enabled: true }, authAlert: { enabled: true } },
  fields: [],
  access: { read: () => false, create: () => false, update: () => false, delete: () => false },
});
