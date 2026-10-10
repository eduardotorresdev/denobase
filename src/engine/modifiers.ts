import type { CollectionConfig, Doc } from "../core/types.ts";
import { isMany } from "../schema/mod.ts";
import { allFields } from "./fields.ts";
import { asList, fromList } from "./values.ts";

/**
 * PB's field modifiers on writes: "f+" appends, "+f" prepends and "f-" removes for multi-value fields (and file);
 * on numbers "f+" adds and "f-" subtracts. Resolved against the sent value, else the stored one.
 */
export function applyModifiers(
  c: CollectionConfig,
  data: Record<string, unknown>,
  original?: Doc,
): Record<string, unknown> {
  const out = { ...data };
  // Most writes send no modifier: looking for one per field is then all the cost.
  if (!Object.keys(data).some((k) => k.startsWith("+") || k.endsWith("+") || k.endsWith("-"))) return out;
  for (const f of allFields(c)) {
    const keys = [`+${f.name}`, `${f.name}+`, `${f.name}-`].filter((k) => k in data);
    for (const key of keys) {
      const value = data[key];
      delete out[key];
      const current = f.name in out ? out[f.name] : original?.[f.name];
      if (f.type === "number") {
        const n = Number(value) || 0;
        out[f.name] = (Number(current) || 0) + (key.endsWith("-") ? -n : n);
        continue;
      }
      if (!isMany(f) && f.type !== "file") continue;
      const list = asList(f, current);
      const given = asList(f, value);
      const next = key.startsWith("+")
        ? [...given, ...list]
        : key.endsWith("+")
        ? [...list, ...given]
        : list.filter((x) => !given.some((g) => (g instanceof File ? g === x : String(g) === String(x))));
      out[f.name] = fromList(f, next);
    }
  }
  return out;
}
