import type { CollectionConfig } from "./types.ts";
import { ApiError, type ErrorData, type FieldError } from "./errors.ts";
import { THUMB_SIZE_RE } from "../files/thumb_size.ts";

/** Every thumb size PB's NotIn refuses: both sides zero leaves nothing to render. */
const ZERO_SIZES = ["0x0", "0x0t", "0x0b", "0x0f"];

/**
 * PB's FileField.ValidateSettings for `thumbs`: Each(NotIn("0x0"...), Match(ThumbSizeRegex)), the first failing rule
 * per item, keyed by index. Like ozzo, both rules skip an empty string, so "" passes.
 */
export function thumbsErrors(thumbs: unknown): Record<string, FieldError> | FieldError | null {
  if (thumbs == null) return null;
  if (!Array.isArray(thumbs)) return { code: "validation_invalid_value", message: "Invalid value." };
  const errs: Record<string, FieldError> = {};
  thumbs.forEach((t, i) => {
    if (t === "" || t == null) return;
    if (typeof t !== "string") errs[i] = { code: "validation_invalid_value", message: "Invalid value." };
    else if (ZERO_SIZES.includes(t)) errs[i] = { code: "validation_not_in_invalid", message: "Must not be in list." };
    else if (!THUMB_SIZE_RE.test(t)) {
      errs[i] = { code: "validation_match_invalid", message: "Must be in a valid format." };
    }
  });
  return Object.keys(errs).length ? errs : null;
}

/** PB's per-field settings errors of a collection, as `data.fields` of its validation error: `{<index>: {<option>: ...}}`. */
export function fieldsOptionsErrors(fields: unknown): Record<string, Record<string, unknown>> | null {
  if (!Array.isArray(fields)) return null;
  const out: Record<string, Record<string, unknown>> = {};
  fields.forEach((f, i) => {
    if (!f || typeof f !== "object" || (f as { type?: unknown }).type !== "file") return;
    const e = thumbsErrors((f as { thumbs?: unknown }).thumbs);
    if (e) out[i] = { thumbs: e };
  });
  return Object.keys(out).length ? out : null;
}

/** Sorted-key, 2-space JSON of ozzo's raw (lowercase, unpunctuated) messages, as Go's json.MarshalIndent writes it. */
function ozzoJson(errs: Record<string, unknown>): string {
  const raw = (v: unknown): unknown => {
    if (v && typeof v === "object" && "code" in v) {
      const m = (v as FieldError).message.replace(/\.$/, "");
      return m[0].toLowerCase() + m.slice(1);
    }
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, raw(o[k])]));
  };
  return JSON.stringify(raw(errs), null, 2);
}

/**
 * PB's import 400: the first collection that fails validation, its errors serialized into one
 * `data.collections` item (core/collection_import.go), the message sentenized by the router.
 */
export function importValidationError(name: string, id: string, fieldsErrors: Record<string, unknown>): ApiError {
  const message = `Data validations failed for collection ${JSON.stringify(name)} (${id}):\n${
    ozzoJson({ fields: fieldsErrors })
  }.`;
  return new ApiError(400, "Failed to import collections.", {
    collections: { code: "validation_collections_import_failure", message },
  });
}

/** PB's 400 for a collection whose field settings fail validation ("Failed to create collection." and kin). */
export function collectionValidationError(message: string, fieldsErrors: Record<string, unknown>): ApiError {
  // PB nests field settings errors by index; ErrorData types only the flat record shape.
  return new ApiError(400, message, { fields: fieldsErrors } as unknown as ErrorData);
}

/** Refuses a collection declared in code with field settings PB would reject, naming the field and the option. */
export function assertCollectionOptions(c: CollectionConfig): void {
  const parts: string[] = [];
  for (const f of c.fields ?? []) {
    if (f.type !== "file") continue;
    const e = thumbsErrors(f.thumbs);
    if (!e) continue;
    const detail = "code" in e
      ? (e as FieldError).message
      : Object.entries(e as Record<string, FieldError>).map(([k, v]) => `${JSON.stringify(f.thumbs![+k])} ${v.message}`)
        .join("; ");
    parts.push(`field "${f.name}" thumbs: ${detail}`);
  }
  if (parts.length) throw new Error(`collection "${c.slug}": invalid ${parts.join(", ")}`);
}
