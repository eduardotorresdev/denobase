import type { CollectionConfig, Doc, Field, Req } from "../core/types.ts";
import { collectionId, getCollection } from "../core/registry.ts";
import { allFields, SECRET_FIELDS } from "./fields.ts";
import { bypass } from "./access.ts";
import { find, findById } from "./read.ts";

/** The read pipeline a record goes through before leaving: hooks, field access, hidden/email strip, expand, fields. */

/**
 * Read pipeline: beforeRead, field afterRead (fills virtuals), afterRead, then field read access and hidden strip.
 * raw is never mutated. With no hooks and no field read access (the common case) nothing is copied until the one
 * sorted output object is built; hidden and email strips skip keys instead of deleting them.
 */
export async function present(
  req: Req,
  c: CollectionConfig,
  raw: Doc,
  opts: { override?: boolean; showHidden?: boolean; expand?: string; fields?: string; memo?: ExpandMemo },
): Promise<Doc> {
  const fields = allFields(c);
  const before = c.hooks?.beforeRead;
  const after = c.hooks?.afterRead;
  const checkAccess = !bypass(req, opts.override);
  let slow = !!before?.length || !!after?.length;
  for (let i = 0; !slow && i < fields.length; i++) {
    const f = fields[i];
    slow = !!f.hooks?.afterRead?.length || (checkAccess && !!f.access?.read);
  }
  let doc: Doc = raw;
  let dropped: string[] | undefined;
  if (slow) {
    // Hooks and field access see (and may change) a working copy that loses each stripped field as it goes.
    doc = { ...raw };
    for (const h of before ?? []) doc = (await h({ req, collection: c, doc })) ?? doc;
    for (const f of fields) {
      for (const h of f.hooks?.afterRead ?? []) {
        doc[f.name] = await h({ req, value: doc[f.name], data: doc, originalDoc: raw, operation: "read" });
      }
    }
    for (const h of after ?? []) doc = (await h({ req, collection: c, doc })) ?? doc;
    for (const f of fields) {
      if (isHidden(req, f) && !opts.showHidden) delete doc[f.name];
      else if (f.access?.read && checkAccess) {
        const ok = await f.access.read({ req, user: req.user, id: doc.id, doc });
        if (!ok) delete doc[f.name];
      }
    }
  } else if (!opts.showHidden) {
    for (const f of fields) if (isHidden(req, f)) (dropped ??= []).push(f.name);
  }
  if (c.auth && !opts.showHidden) {
    const visibility = dropped?.includes("emailVisibility") ? undefined : doc.emailVisibility;
    if (!(await emailVisible(req, c, doc.id, visibility))) (dropped ??= []).push("email");
  }
  const out = sortedRecord(c, doc, dropped);
  if (opts.expand) await expandDoc(req, c, out, opts.expand, opts.memo);
  // expand (asked for or set by a hook) and fields reshape the record: re-sort, as PB serializes maps.
  return opts.expand || opts.fields || "expand" in out
    ? sortKeys(opts.fields ? pickFields(out, opts.fields) : out)
    : out;
}

/** PB unhides hidden fields for superusers, except the password and tokenKey it never exports. */
function isHidden(req: Req, f: Field): boolean {
  return !!f.hidden && (SECRET_FIELDS.has(f.name) || !req.isSuperuser);
}

/** PB autoResolveRecordsFlags: email shows to superusers, the owner, managers, or when emailVisibility is set. */
async function emailVisible(req: Req, c: CollectionConfig, id: string, visibility: unknown): Promise<boolean> {
  if (req.isSuperuser || visibility === true) return true;
  if (req.user?.collection === c.slug && req.user.id === id) return true;
  const fn = typeof c.auth === "object" ? c.auth.manage : undefined;
  return !!fn && (await fn({ req, user: req.user, id })) === true;
}

/**
 * The record as PB serializes it: doc's keys minus dropped, plus collectionId and collectionName, in sorted order.
 * Records of one collection share their key list, so the sorted shape is compiled once per key list into an object
 * literal (one allocation, one V8 shape); the last list is checked first, then a few others hooks may produce.
 */
function sortedRecord(c: CollectionConfig, doc: Doc, dropped: string[] | undefined): Doc {
  const keys = Object.keys(doc);
  const drop = dropped?.join("\0") ?? "";
  let shapes = recordShapes.get(c);
  if (!shapes) recordShapes.set(c, shapes = { last: undefined, bySignature: new Map() });
  let shape = shapes.last;
  if (!shape || shape.drop !== drop || !sameKeys(shape.keys, keys)) {
    const signature = `${drop}\u0001${keys.join("\0")}`;
    shape = shapes.bySignature.get(signature) ?? compileShape(keys, dropped);
    if (shapes.bySignature.size < MAX_SHAPES) shapes.bySignature.set(signature, shape);
    shape.drop = drop;
    shapes.last = shape;
  }
  return shape.build(doc, collectionId(c), c.slug);
}

interface Shape {
  keys: string[];
  drop: string;
  build: (doc: Doc, collectionId: string, collectionName: string) => Doc;
}

/** Past this many key lists per collection (hooks returning free-form docs) new ones compile without being kept. */
const MAX_SHAPES = 32;
const recordShapes = new WeakMap<CollectionConfig, { last: Shape | undefined; bySignature: Map<string, Shape> }>();

function compileShape(keys: string[], dropped: string[] | undefined): Shape {
  const set = new Set(keys);
  for (const k of dropped ?? []) set.delete(k);
  set.add("collectionId").add("collectionName");
  const sorted = [...set].sort();
  const value = (k: string) =>
    k === "collectionId" ? "id" : k === "collectionName" ? "name" : `doc[${JSON.stringify(k)}]`;
  // A literal "__proto__" key would set the prototype where assignment does too, but only for object values: keep
  // the old assignment loop for that one pathological key (an own __proto__ comes from JSON.parse in a hook).
  const build = sorted.includes("__proto__")
    ? (doc: Doc, id: string, name: string) => {
      const out: Record<string, unknown> = {};
      for (const k of sorted) out[k] = k === "collectionId" ? id : k === "collectionName" ? name : doc[k];
      return out as Doc;
    }
    : new Function(
      `return (doc, id, name) => ({ ${sorted.map((k) => `${JSON.stringify(k)}: ${value(k)}`).join(", ")} });`,
    )();
  return { keys, drop: "", build };
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * PB serializes a record with its keys sorted; same for expand and each expanded record.
 * Field values (json included) keep their own order.
 */
function sortKeys(doc: Doc): Doc {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) out[k] = doc[k];
  const exp = out.expand as Record<string, unknown> | undefined;
  if (exp && typeof exp === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(exp).sort()) {
      const v = exp[k];
      sorted[k] = Array.isArray(v)
        ? v.map((d) => sortKeys(d as Doc))
        : v && typeof v === "object"
        ? sortKeys(v as Doc)
        : v;
    }
    out.expand = sorted;
  }
  return out as Doc;
}

/** PB expand: relations resolved through the related collection's read access; denied or missing ones are omitted. */
/** One list's expand lookups: a related id repeated across the page's items is read once (key collection|id|nested). */
export type ExpandMemo = Map<string, Promise<Doc | null>>;

async function expandDoc(req: Req, c: CollectionConfig, doc: Doc, expand: string, memo?: ExpandMemo): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const path of expand.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [head, ...rest] = path.split(".");
    const list = groups.get(head) ?? [];
    if (rest.length) list.push(rest.join("."));
    groups.set(head, list);
  }
  const out: Record<string, unknown> = {};
  for (const [name, nested] of groups) {
    const f = allFields(c).find((x) => x.name === name);
    if (!f) {
      const via = await expandVia(req, c, doc, name, nested);
      if (via?.length) out[name] = via;
      continue;
    }
    if (f.type !== "relationship" || doc[name] == null) continue;
    const load = async (id: string) => {
      try {
        return await findById({ collection: f.relationTo, req, id, expand: nested.join(",") || undefined });
      } catch {
        return null;
      }
    };
    const one = async (id: string) => {
      if (!memo) return await load(id);
      const key = `${f.relationTo}|${id}|${nested.join(",")}`;
      let p = memo.get(key);
      if (!p) memo.set(key, p = load(id));
      const d = await p;
      // Each item gets its own copy: a caller that edits one item's expand must not reach the others.
      return d && structuredClone(d);
    };
    if (f.hasMany) {
      const ids = Array.isArray(doc[name]) ? doc[name] as string[] : [];
      const docs = (await Promise.all(ids.map(one))).filter((d): d is Doc => !!d);
      if (docs.length) out[name] = docs;
    } else {
      const d = await one(String(doc[name]));
      if (d) out[name] = d;
    }
  }
  if (Object.keys(out).length) doc.expand = out;
}

/**
 * PB back-relation expand `<collection>_via_<field>`: the records of <collection> whose relation <field> points at
 * this doc, through that collection's list access (up to 1000, PB's cap). Unknown collection or field is ignored.
 */
async function expandVia(
  req: Req,
  c: CollectionConfig,
  doc: Doc,
  name: string,
  nested: string[],
): Promise<Doc[] | null> {
  const m = /^(.+)_via_(.+)$/.exec(name);
  if (!m) return null;
  let target: CollectionConfig;
  try {
    target = getCollection(m[1]);
  } catch {
    return null;
  }
  const f = allFields(target).find((x) => x.name === m[2]);
  if (f?.type !== "relationship" || f.relationTo !== c.slug) return null;
  const id = String(doc.id).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  try {
    const r = await find({
      collection: target.slug,
      req,
      filter: f.hasMany ? `${f.name} ?= '${id}'` : `${f.name} = '${id}'`,
      perPage: 1000,
      skipTotal: true,
      expand: nested.join(",") || undefined,
    });
    return r.items;
  } catch {
    return null;
  }
}

/** PB fields param: comma paths, "*" for all keys at a level, nested via dots (expand.cargo.titulo). */
function pickFields(doc: Doc, fields: string): Doc {
  type Tree = Map<string, Tree>;
  const tree: Tree = new Map();
  for (const path of fields.split(",").map((s) => s.trim()).filter(Boolean)) {
    let node = tree;
    for (const part of path.split(".")) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part)!;
    }
  }
  const pick = (v: unknown, t: Tree): unknown => {
    if (t.size === 0 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => pick(x, t));
    const src = v as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    if (t.has("*")) { for (const k of Object.keys(src)) res[k] = src[k]; }
    for (const [k, sub] of t) if (k !== "*" && k in src) res[k] = pick(src[k], sub);
    return res;
  };
  return pick(doc, tree) as Doc;
}
