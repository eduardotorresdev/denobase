import type { CollectionConfig } from "./types.ts";

/** Identity helper: keeps literal types and is the single place to add config validation later. */
export function defineCollection<const C extends CollectionConfig>(config: C): C {
  return config;
}
