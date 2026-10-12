import type { Context } from "hono";
import type { AppEnv } from "./app.ts";
import type { CollectionConfig, Field } from "../core/types.ts";
import { badRequest } from "../core/errors.ts";
import { allFields } from "../engine/fields.ts";
import { isMany as isMultiple } from "../schema/mod.ts";
import { DEFAULT_MAX_SIZE } from "../engine/files.ts";
import { boundaryOf, spoolMultipart } from "../files/spool.ts";

/** PB tools/router JSONPayloadKey: a JSON object sent alongside multipart fields and files. */
export const JSON_PAYLOAD = "@jsonPayload";
const INVALID = "Failed to load the submitted data due to invalid formatting.";

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw badRequest(INVALID);
  return v as Record<string, unknown>;
}

/** PB list.ToUniqueStringSlice on a form string: a JSON array string is the list, else the string itself. */
function stringList(v: string): unknown[] {
  if (v === "") return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* plain value */ }
  return [v];
}

/** Form values are strings (or files); each field casts them the way PB's record setters do. */
function cast(f: Field | undefined, values: (string | File)[]): unknown {
  if (f?.type === "file") return values.length > 1 || isMultiple(f) ? values : values[0];
  const strings = values.map((v) => (typeof v === "string" ? v : v.name));
  if (f && isMultiple(f)) return [...new Set(strings.flatMap(stringList))];
  const last = strings[strings.length - 1];
  switch (f?.type) {
    case "number":
      return last === "" ? 0 : Number(last);
    case "checkbox":
      return ["1", "t", "true", "on"].includes(last.toLowerCase());
    case "json":
      try {
        return JSON.parse(last);
      } catch {
        return last;
      }
    default:
      return strings.length > 1 && !f ? strings : last;
  }
}

/** Field a form key targets, modifiers ("+f", "f+", "f-") included. */
function fieldOf(c: CollectionConfig | undefined, key: string): Field | undefined {
  const name = key.replace(/^\+/, "").replace(/[+-]$/, "");
  return c && allFields(c).find((f) => f.name === name);
}

/**
 * Bytes of a file part kept on disk: the field's maxSize (PB's default when unset). Anything past it is only
 * counted, which is enough for validation to fail with the size sent; a part under a non-file key keeps none.
 */
export function uploadLimit(f: Field | undefined): number {
  if (f?.type !== "file") return 0;
  return f.maxSize && f.maxSize > 0 ? f.maxSize : DEFAULT_MAX_SIZE;
}

/** Groups a FormData by key, PB's url.Values. */
export function formEntries(form: FormData): Map<string, (string | File)[]> {
  const out = new Map<string, (string | File)[]>();
  for (const [k, v] of form.entries()) {
    const list = out.get(k) ?? [];
    list.push(v);
    out.set(k, list);
  }
  return out;
}

/** Record data from a multipart form: @jsonPayload objects first, then the cast form fields. */
export function formToData(entries: Map<string, (string | File)[]>, c?: CollectionConfig): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const raw of entries.get(JSON_PAYLOAD) ?? []) {
    try {
      Object.assign(data, object(JSON.parse(String(raw))));
    } catch {
      throw badRequest(INVALID);
    }
  }
  for (const [k, values] of entries) if (k !== JSON_PAYLOAD) data[k] = cast(fieldOf(c, k), values);
  return data;
}

/** A request body as record data: JSON object or multipart form (PB BindBody); 400 otherwise. */
export async function readBody(c: Context<AppEnv>, col?: CollectionConfig): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      const boundary = boundaryOf(type);
      form = boundary
        ? await spoolMultipart(c.req.raw.body, boundary, (key) => uploadLimit(fieldOf(col, key)))
        : await c.req.raw.formData();
    } catch {
      throw badRequest(INVALID);
    }
    return formToData(formEntries(form), col);
  }
  try {
    return object(await c.req.json());
  } catch {
    throw badRequest(INVALID);
  }
}
