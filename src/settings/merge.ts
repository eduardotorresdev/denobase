import { defaultSettings, type SettingsPatch } from "./defaults.ts";
import type { Settings } from "./model.ts";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** PB binds a body onto a clone: objects merge key by key, anything else (arrays included) replaces. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue;
    out[k] = isObject(out[k]) ? mergeSettings(out[k], v) : v;
  }
  return out as T;
}

export function resolveSettings(...patches: (SettingsPatch | undefined)[]): Settings {
  return patches.reduce<Settings>((s, p) => mergeSettings(s, p ?? {}), defaultSettings());
}
