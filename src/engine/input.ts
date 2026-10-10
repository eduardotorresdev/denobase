import type { CollectionConfig, Field, IdConfig, Req } from "../core/types.ts";
import { newId, txState } from "../core/db.ts";
import * as sql from "../store/sqlite.ts";
import { allFields, storedFields } from "./fields.ts";
import { failed } from "./validate.ts";

/** What a write may carry: the record id, known keys only, defaults, and the db-backed checks validate() cannot see. */

const IMPLICIT = new Set(["id", "created", "updated"]);

const DEFAULT_ID: IdConfig = { min: 15, max: 15, pattern: /^[a-z0-9]+$/, autogenerate: true };

/**
 * PB's default id field: a client may choose the id on create (15 chars of [a-z0-9]); a system call may insert any
 * id (migrated data). A collection with `id` swaps the generator and the client-side checks for its own. An id
 * already taken is pk_invalid, like PB's check.
 */
export function recordId(req: Req, c: CollectionConfig, raw: unknown, override?: boolean): string {
  const rule = c.id ?? DEFAULT_ID;
  const bad = (code: string, message: string) => failed("create", { id: { code, message } });
  if (raw === undefined || raw === null || raw === "") {
    if (rule.generate) return generated(req, c, rule.generate);
    if (rule.autogenerate || override) return newId();
    throw bad("validation_required", "Cannot be blank.");
  }
  const id = String(raw);
  if (override) return id;
  if (id.length < rule.min) throw bad("validation_min_text_constraint", `Must be at least ${rule.min} character(s).`);
  if (id.length > rule.max) {
    throw bad("validation_max_text_constraint", `Must be no more than ${rule.max} character(s).`);
  }
  if (!rule.pattern.test(id)) throw bad("validation_invalid_format", "Invalid value format.");
  if (sql.findOne(req.db, c, id)) {
    throw bad("validation_pk_invalid", "The record primary key is invalid or already exists.");
  }
  return id;
}

/** A custom pattern has a much smaller space than PB's default: a taken id is drawn again, like PB's retry. */
function generated(req: Req, c: CollectionConfig, generate: () => string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = generate();
    if (!sql.findOne(req.db, c, id)) return id;
  }
  return generate();
}

/** Keeps only known, non-implicit keys so clients cannot forge id/created or write undeclared columns. */
export function known(c: CollectionConfig, data: Record<string, unknown>): Record<string, unknown> {
  const names = fieldNames(c);
  return Object.fromEntries(Object.entries(data).filter(([k]) => names.has(k) && !IMPLICIT.has(k)));
}

/** The field names of a collection, memoized per fields array (what changes when the schema does). */
const fieldNamesOf = new WeakMap<CollectionConfig, { fields: Field[]; size: number; names: Set<string> }>();

function fieldNames(c: CollectionConfig): Set<string> {
  const all = allFields(c);
  const hit = fieldNamesOf.get(c);
  if (hit?.fields === all && hit.size === all.length) return hit.names;
  const out = new Set(all.map((f) => f.name));
  fieldNamesOf.set(c, { fields: all, size: all.length, names: out });
  return out;
}

/** Checks DB-backed rules validate() cannot see: uniqueness and relation targets existing. */
export function checkDb(
  req: Req,
  c: CollectionConfig,
  data: Record<string, unknown>,
  op: "create" | "update",
  id: string,
) {
  const errs: Record<string, { code: string; message: string }> = {};
  for (const f of storedFields(c)) {
    const v = data[f.name];
    if (v === undefined || v === null || v === "") continue;
    if (f.unique && sql.taken(req.db, c, f, v, id)) {
      errs[f.name] = { code: "validation_not_unique", message: "Value must be unique." };
    }
    if (
      f.type === "relationship" &&
      !relationExists(req, f.relationTo, f.hasMany ? v as string[] : [v as string])
    ) {
      errs[f.name] = {
        code: "validation_missing_rel_records",
        message: "Failed to find all relation records with the provided ids.",
      };
    }
  }
  if (Object.keys(errs).length) throw failed(op, errs);
}

const FOUND = "denobase:relations-found";

/**
 * The relation targets already found in this transaction: a transition that writes fifty rows pointing at the same
 * user and stages checks each once. Only hits are kept, and any delete in the transaction drops them all
 * (forgetFoundRelations): a row gone since it was found is still refused, by the foreign key.
 */
function relationExists(req: Req, target: string, ids: string[]): boolean {
  if (!req.db.isTransaction) return sql.allExist(req.db, target, ids);
  const found = txState(req.db, FOUND, () => new Map<string, Set<string>>());
  const known = found.get(target);
  const missing = known ? ids.filter((id) => !known.has(id)) : ids;
  if (!missing.length) return true;
  if (!sql.allExist(req.db, target, missing)) return false;
  const set = known ?? new Set<string>();
  for (const id of missing) set.add(id);
  found.set(target, set);
  return true;
}

/** Called by every delete: what was found earlier in the transaction may be what is going away (or cascading). */
export function forgetFoundRelations(req: Req): void {
  if (req.db.isTransaction) txState(req.db, FOUND, () => new Map<string, Set<string>>()).clear();
}

export function withDefaults(c: CollectionConfig, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of allFields(c)) {
    if (out[f.name] === undefined && f.defaultValue !== undefined) out[f.name] = structuredClone(f.defaultValue);
  }
  return out;
}
