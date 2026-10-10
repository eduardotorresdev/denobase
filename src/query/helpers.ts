import type { CollectionConfig, Doc } from "../core/types.ts";
import { badRequest } from "../core/errors.ts";
import { orderByToSql, parseSort } from "../store/query.ts";

/** PB sort ("-created,titulo") to "ORDER BY ..." ("" when empty); unknown fields -> ApiError 400. */
export function sortToSql(c: CollectionConfig, sort: string): string {
  return orderByToSql(c, parseSort(sort));
}

/** Expand tree from PB `expand=cargo,a.b`; depth capped at 6 like PB. */
export type ExpandTree = { [rel: string]: ExpandTree };
export function parseExpand(expand: string): ExpandTree {
  const tree: ExpandTree = {};
  for (const raw of expand.split(",")) {
    const path = raw.trim();
    if (!path) continue;
    const segs = path.split(".");
    if (segs.length > 6) throw badRequest("Expand is too deep.");
    let node = tree;
    for (const s of segs) {
      if (!s) throw badRequest(`Invalid expand "${path}".`);
      node = node[s] ??= {};
    }
  }
  return tree;
}

/** PB `fields=id,titulo,expand.cargo.titulo`; null means all. Modifiers like `:excerpt` are ignored. */
export type FieldsTree = { [name: string]: FieldsTree | true };
export function parseFields(fields: string): FieldsTree | null {
  const tree: FieldsTree = {};
  let any = false;
  for (const raw of fields.split(",")) {
    const path = raw.trim().replace(/:.*$/, "");
    if (!path) continue;
    if (path === "*") return null;
    any = true;
    const segs = path.split(".");
    let node = tree;
    segs.forEach((s, i) => {
      if (i === segs.length - 1) node[s] = node[s] === undefined ? true : node[s];
      else {
        const n = node[s];
        node = (node[s] = n && n !== true ? n : {}) as FieldsTree;
      }
    });
  }
  return any ? tree : null;
}

/** Projects a record (with nested expand objects/arrays) onto a fields tree. */
export function pickFields(doc: Doc | Record<string, unknown>, tree: FieldsTree | null): Record<string, unknown> {
  if (!tree) return doc;
  const pick = (v: unknown, t: FieldsTree | true): unknown => {
    if (t === true || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => pick(x, t));
    if ("*" in t) return v;
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(t)) {
      if (k in (v as object)) out[k] = pick((v as Record<string, unknown>)[k], sub);
    }
    return out;
  };
  return pick(doc, tree) as Record<string, unknown>;
}
