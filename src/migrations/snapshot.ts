import type { CollectionConfig, Field } from "../core/types.ts";
import { indexName } from "../schema/mod.ts";
import type { CollectionSnapshot, Snapshot } from "./types.ts";

/** Collections as plain data: what migrations diff, replay and store; functions (hooks, access, zod) stripped. */

export const clone = <T>(v: T): T => structuredClone(v);

/** Key-sorted JSON so field equality ignores property order. */
export function canon(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x,
  );
}

function stripField(f: Field): CollectionSnapshot["fields"][number] {
  const { hooks: _h, access: _a, schema: _s, ...rest } = f;
  // defaultValue may be a function or non-JSON; only JSON-safe values belong in a migration file.
  return JSON.parse(JSON.stringify(rest));
}

export function configToSnapshot(cs: CollectionConfig[]): Snapshot {
  const out: Snapshot = {};
  for (const c of cs) {
    out[c.slug] = {
      slug: c.slug,
      auth: !!c.auth,
      fields: c.fields.map(stripField),
      indexes: (c.indexes ?? []).map((i) => ({
        name: indexName(c.slug, i.fields, i.name),
        fields: [...i.fields],
        unique: !!i.unique,
        ...(i.desc?.length ? { desc: [...i.desc] } : {}),
        ...(i.where ? { where: i.where } : {}),
      })),
      ...(c.view ? { view: clone(c.view) } : {}),
    };
  }
  return indexesByName(out);
}

/** Index order carries no meaning: kept by name so a replay matches the config whatever order the history ran. */
export function indexesByName(s: Snapshot): Snapshot {
  const key = (i: { name?: string }) => i.name ?? "";
  for (const c of Object.values(s)) c.indexes.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return s;
}
