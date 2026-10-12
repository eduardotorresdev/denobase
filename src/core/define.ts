import type { CollectionConfig } from "./types.ts";
import { assertCollectionOptions } from "./field_options.ts";

/** Identity helper: keeps literal types, and refuses field settings PB would reject (thumbs sizes). */
export function defineCollection<const C extends CollectionConfig>(config: C): C {
  assertCollectionOptions(config);
  return config;
}
