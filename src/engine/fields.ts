import type { CollectionConfig, Field } from "../core/types.ts";

/** Auth columns are implicit in configs (CONTRACTS invariant); modelled as fields so one code path handles them. */
const AUTH_FIELDS: Field[] = [
  { name: "email", type: "email", required: true, unique: true },
  { name: "passwordHash", type: "text", hidden: true },
  { name: "tokenKey", type: "text", hidden: true },
  { name: "emailVisibility", type: "checkbox" },
  { name: "verified", type: "checkbox" },
];

/** Never exported, not even to superusers (PB always drops password and tokenKey). */
export const SECRET_FIELDS = new Set(["passwordHash", "tokenKey"]);

/** Declared fields plus implicit auth fields; a declared field with the same name wins. */
export function allFields(c: CollectionConfig): Field[] {
  if (!c.auth) return c.fields;
  // Read once per record on every read: memoized per fields array, which is what changes when the schema does.
  const hit = authFields.get(c);
  if (hit?.fields === c.fields && hit.size === c.fields.length) return hit.all;
  const own = new Set(c.fields.map((f) => f.name));
  const all = [...AUTH_FIELDS.filter((f) => !own.has(f.name)), ...c.fields];
  authFields.set(c, { fields: c.fields, size: c.fields.length, all });
  return all;
}

const authFields = new WeakMap<CollectionConfig, { fields: Field[]; size: number; all: Field[] }>();

export function storedFields(c: CollectionConfig): Field[] {
  return allFields(c).filter((f) => !f.virtual);
}
