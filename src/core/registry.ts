import type { CollectionConfig } from "./types.ts";
import { superusers } from "./superusers.ts";
import { notFound } from "./errors.ts";
import { deriveViewFields } from "../view/mod.ts";
import { assertCollectionOptions } from "./field_options.ts";

/**
 * Source of truth for migrate create (diff), the HTTP router and auth. Starts with the system collections; the
 * consumer appends its own through registerCollections. Order matters for FK creation.
 */
export const collections: CollectionConfig[] = [superusers];

/**
 * Appends consumer collections in place, so every module holding this array sees them. Idempotent per slug.
 * A view's fields are derived here, so its sources must be registered first (or in the same call, before it).
 */
export function registerCollections(...cs: CollectionConfig[]): void {
  for (const c of cs) {
    if (collections.some((x) => x.slug === c.slug)) continue;
    // Configs need not come through defineCollection, so the settings are checked again here.
    assertCollectionOptions(c);
    collections.push(c);
    if (c.view) c.fields = deriveViewFields(c.view, collections);
  }
}

/** Only registered auth collections may sign tokens or OTPs; also keeps arbitrary table names out of SQL. */
export function isAuthCollection(slug: string): boolean {
  return collections.some((c) => c.slug === slug && !!c.auth);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** IEEE crc32, the checksum PB derives collection ids from. */
export function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function collectionType(c: CollectionConfig): "base" | "auth" | "view" {
  return c.view ? "view" : c.auth ? "auth" : "base";
}

/** PB's id for a collection created without one: "pbc_" + crc32(type + name); _superusers is pbc_3142635823. */
export function collectionId(c: CollectionConfig): string {
  const key = collectionType(c) + c.slug;
  let id = collectionIds.get(key);
  if (id === undefined) collectionIds.set(key, id = `pbc_${crc32(key)}`);
  return id;
}

/** Every presented record carries its collectionId: crc32 once per type+name, not once per record. */
const collectionIds = new Map<string, string>();

/** By name or id, like PB's FindCachedCollectionByNameOrId. */
export function getCollection(slug: string, list: CollectionConfig[] = collections): CollectionConfig {
  const c = list.find((x) => x.slug === slug) ?? list.find((x) => collectionId(x) === slug);
  if (!c) throw notFound(`Missing collection context.`);
  return c;
}
