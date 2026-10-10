import type { CollectionConfig } from "../core/types.ts";
import { collections } from "../core/registry.ts";
import { fromDb, tableName, toDb } from "../schema/mod.ts";
import { compilePb, whereToSql } from "../query/mod.ts";
import { orderByToSql } from "../store/query.ts";

/** Collaborators behind one mutable seam so engine tests can run against fakes while siblings are in flight. */
export const deps = {
  tableName,
  toDb,
  fromDb,
  whereToSql,
  orderByToSql,
  compilePb,
  collections: (): CollectionConfig[] => collections,
};
export type EngineDeps = typeof deps;

/** Swaps collaborators for the duration of fn; returns the restore function for test teardown. */
export function overrideDeps(patch: Partial<EngineDeps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, patch);
  return () => Object.assign(deps, prev);
}
