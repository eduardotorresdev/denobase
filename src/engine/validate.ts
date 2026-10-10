import { z, type ZodType } from "zod";
import type { CollectionConfig, Field } from "../core/types.ts";
import { ApiError, badRequest } from "../core/errors.ts";
import { allFields } from "./fields.ts";
import { EMAIL } from "../core/text.ts";

type Errs = ApiError["data"];
type FieldError = { code: string; message: string };

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

const jsonValue = z.unknown().refine((v) => {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}, { params: { code: "validation_invalid_json" }, message: "Must be valid JSON." });

/** The type check of a field as a zod schema; the field's own schema, if any, runs on its output. */
export function fieldSchema(f: Field): ZodType {
  let s: ZodType;
  switch (f.type) {
    case "text": {
      let t = z.string();
      if (f.minLength !== undefined) t = t.min(f.minLength);
      // PB caps text at 5000 characters when no max is set.
      t = t.max(f.maxLength ?? 5000);
      s = t;
      break;
    }
    case "email":
      s = z.string().regex(EMAIL);
      break;
    case "number": {
      let n = f.integer ? z.int() : z.number();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      s = n;
      break;
    }
    case "checkbox":
      s = z.boolean();
      break;
    case "date":
      s = z.string().refine((v) => !Number.isNaN(Date.parse(v)));
      break;
    case "json":
      s = jsonValue;
      break;
    case "select": {
      const one = z.enum(f.options as [string, ...string[]]);
      s = f.hasMany ? z.array(one) : one;
      break;
    }
    case "relationship": {
      const one = z.string().min(1);
      s = f.hasMany ? z.array(one) : one;
      break;
    }
    case "file":
      // Uploads are already names here (prepareFiles); count, size and type were checked there.
      s = (f.maxSelect ?? 1) > 1 ? z.array(z.string()) : z.string();
      break;
  }
  return f.schema ? s.pipe(f.schema) : s;
}

/**
 * The schema of each field object, built once: zod schemas are immutable, and rebuilding every field's on each write
 * was most of a write's own time (a Fita color on 350 sides validated 350 whole records). A changed collection
 * brings new field objects, so the cache never serves an old shape.
 */
const schemas = new WeakMap<Field, ZodType>();
function schemaOf(f: Field): ZodType {
  let s = schemas.get(f);
  if (!s) schemas.set(f, s = fieldSchema(f));
  return s;
}

/** Zod issue to the PB error code and message the field type answers with, so clients keep PB's contract. */
function pbError(f: Field, issue: z.core.$ZodIssue): FieldError {
  const custom = (issue as { params?: { code?: string } }).params?.code;
  if (custom) return { code: custom, message: issue.message };
  const min = (issue as { minimum?: number }).minimum;
  const max = (issue as { maximum?: number }).maximum;
  switch (f.type) {
    case "text":
      if (issue.code === "too_small") {
        return { code: "validation_min_text_constraint", message: `Must be at least ${min} character(s).` };
      }
      if (issue.code === "too_big") {
        return { code: "validation_max_text_constraint", message: `Must be no more than ${max} character(s).` };
      }
      return { code: "validation_invalid_value", message: "Must be a string." };
    case "email":
      return { code: "validation_is_email", message: "Must be a valid email address." };
    case "number":
      if (issue.code === "too_small") {
        return { code: "validation_min_number_constraint", message: `Must be >= ${min}.` };
      }
      if (issue.code === "too_big") return { code: "validation_max_number_constraint", message: `Must be <= ${max}.` };
      if (issue.code === "invalid_type" && (issue as { expected?: string }).expected === "int") {
        return { code: "validation_only_int_constraint", message: "Only integers allowed." };
      }
      return { code: "validation_invalid_number", message: "Must be a number." };
    case "checkbox":
      return { code: "validation_invalid_bool", message: "Must be a boolean." };
    case "date":
      return { code: "validation_invalid_date", message: "Must be a valid date." };
    case "json":
      return { code: "validation_invalid_value", message: issue.message };
    case "select":
      if (f.hasMany && issue.code === "invalid_type") {
        return { code: "validation_invalid_value", message: "Must be a list." };
      }
      return { code: "validation_invalid_value", message: `Must be one of: ${f.options.join(", ")}.` };
    case "relationship":
      return { code: "validation_invalid_value", message: "Must be record id(s)." };
    case "file":
      return { code: "validation_invalid_value", message: "Invalid file value." };
  }
}

/**
 * Validates the full candidate record (update passes the merged doc) so required holds after partial PATCH:
 * required first, then each field's zod schema, then the collection's schema over the record.
 */
export function validate(
  c: CollectionConfig,
  data: Record<string, unknown>,
  op: "create" | "update",
  errs: Errs = {},
): void {
  for (const f of allFields(c)) {
    if (f.virtual || errs[f.name]) continue;
    const v = data[f.name];
    if (isBlank(v)) {
      // Checkbox false is a value, not blank; PB only rejects missing required non-bool fields.
      if (f.required && f.type !== "checkbox") {
        errs[f.name] = { code: "validation_required", message: "Cannot be blank." };
      }
      continue;
    }
    const r = schemaOf(f).safeParse(v);
    if (!r.success) errs[f.name] = pbError(f, r.error.issues[0]);
  }
  if (!Object.keys(errs).length && c.schema) {
    const r = c.schema.safeParse(data);
    if (!r.success) {
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? "");
        const code = (issue as { params?: { code?: string } }).params?.code ?? "validation_invalid_value";
        errs[key] ??= { code, message: issue.message };
      }
    }
  }
  if (Object.keys(errs).length) throw failed(op, errs);
}

export function failed(op: "create" | "update", errs: Errs): ApiError {
  return badRequest(`Failed to ${op} record.`, errs);
}
