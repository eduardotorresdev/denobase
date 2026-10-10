/**
 * Parity of the compiled read path (row decoder, present, DISTINCT only on joins) with the per-row implementation it
 * replaced, kept below as the reference: same keys, same key order, same values and types, for every field type and
 * read option.
 */
import { assertEquals } from "@std/assert";
import type { AuthUser, CollectionConfig, Doc, Field, Req } from "../core/types.ts";
import { collectionId, registerCollections } from "../core/registry.ts";
import { dbWith } from "../testing/mod.ts";
import { createStore } from "./mod.ts";
import * as sql from "./sqlite.ts";
import { allFields, SECRET_FIELDS, storedFields } from "../engine/fields.ts";
import { bypass } from "../engine/access.ts";
import { find, findById, makeReq } from "../engine/mod.ts";
import { present } from "../engine/present.ts";
import { isMany } from "../schema/mod.ts";

// ---- Reference: the read path as it was before the compiled decoder and present (one field at a time). ----

function refFromDb(field: Field, value: unknown): unknown {
  if (isMany(field)) return value == null || value === "" ? [] : JSON.parse(String(value));
  switch (field.type) {
    case "checkbox":
      return !!value;
    case "json":
      return value == null || value === "" ? null : JSON.parse(String(value));
    case "number":
      return value == null ? 0 : Number(value);
    default:
      return value == null ? "" : value;
  }
}

function refDecode(c: CollectionConfig, row: Record<string, unknown>): Doc {
  const doc: Record<string, unknown> = { id: row.id, created: row.created, updated: row.updated };
  for (const f of storedFields(c)) doc[f.name] = refFromDb(f, row[f.name]);
  return doc as Doc;
}

type Opts = { override?: boolean; showHidden?: boolean; expand?: string; fields?: string };

async function refPresent(req: Req, c: CollectionConfig, raw: Doc, opts: Opts): Promise<Doc> {
  let doc: Doc = { ...raw };
  for (const h of c.hooks?.beforeRead ?? []) doc = (await h({ req, collection: c, doc })) ?? doc;
  for (const f of allFields(c)) {
    for (const h of f.hooks?.afterRead ?? []) {
      doc[f.name] = await h({ req, value: doc[f.name], data: doc, originalDoc: raw, operation: "read" });
    }
  }
  for (const h of c.hooks?.afterRead ?? []) doc = (await h({ req, collection: c, doc })) ?? doc;
  for (const f of allFields(c)) {
    const hidden = f.hidden && (SECRET_FIELDS.has(f.name) || !req.isSuperuser);
    if (hidden && !opts.showHidden) delete doc[f.name];
    else if (f.access?.read && !bypass(req, opts.override)) {
      const ok = await f.access.read({ req, user: req.user, id: doc.id, doc });
      if (!ok) delete doc[f.name];
    }
  }
  if (c.auth && !opts.showHidden && !(await refEmailVisible(req, c, doc))) delete doc.email;
  doc.collectionId = collectionId(c);
  doc.collectionName = c.slug;
  if (opts.expand) await refExpand(req, c, doc, opts.expand);
  return refSortKeys(opts.fields ? refPickFields(doc, opts.fields) : doc);
}

async function refEmailVisible(req: Req, c: CollectionConfig, doc: Doc): Promise<boolean> {
  if (req.isSuperuser || doc.emailVisibility === true) return true;
  if (req.user?.collection === c.slug && req.user.id === doc.id) return true;
  const fn = typeof c.auth === "object" ? c.auth.manage : undefined;
  return !!fn && (await fn({ req, user: req.user, id: doc.id })) === true;
}

function refSortKeys(doc: Doc): Doc {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) out[k] = doc[k];
  const exp = out.expand as Record<string, unknown> | undefined;
  if (exp && typeof exp === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(exp).sort()) {
      const v = exp[k];
      sorted[k] = Array.isArray(v)
        ? v.map((d) => refSortKeys(d as Doc))
        : v && typeof v === "object"
        ? refSortKeys(v as Doc)
        : v;
    }
    out.expand = sorted;
  }
  return out as Doc;
}

/** Forward relations only (the _via_ path is the same code before and after; read_test covers it). */
async function refExpand(req: Req, c: CollectionConfig, doc: Doc, expand: string): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const name of expand.split(",").map((s) => s.trim()).filter(Boolean)) {
    const f = allFields(c).find((x) => x.name === name);
    if (f?.type !== "relationship" || doc[name] == null) continue;
    const one = (id: string) => findById({ collection: f.relationTo, req, id }).catch(() => null);
    if (f.hasMany) {
      const docs = (await Promise.all((doc[name] as string[]).map(one))).filter((d): d is Doc => !!d);
      if (docs.length) out[name] = docs;
    } else {
      const d = await one(String(doc[name]));
      if (d) out[name] = d;
    }
  }
  if (Object.keys(out).length) doc.expand = out;
}

function refPickFields(doc: Doc, fields: string): Doc {
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

// ---- Fixtures: every field type, hidden, field access, hooks, an auth collection. ----

const rp_tags = {
  slug: "rp_tags",
  fields: [{ name: "nome", type: "text" }],
  access: { read: () => true },
} satisfies CollectionConfig;
const ALL_TYPES: Field[] = [
  { name: "texto", type: "text" },
  { name: "mail", type: "email" },
  { name: "num", type: "number" },
  { name: "inteiro", type: "number", integer: true },
  { name: "flag", type: "checkbox" },
  { name: "quando", type: "date" },
  { name: "dados", type: "json" },
  { name: "opcao", type: "select", options: ["a", "b"] },
  { name: "opcoes", type: "select", options: ["a", "b"], hasMany: true },
  { name: "tag", type: "relationship", relationTo: "rp_tags" },
  { name: "tags", type: "relationship", relationTo: "rp_tags", hasMany: true },
  { name: "anexo", type: "file" },
  { name: "anexos", type: "file", maxSelect: 3 },
  { name: "oculto", type: "text", hidden: true },
  { name: "calculado", type: "text", virtual: true },
];
const rp_plain: CollectionConfig = { slug: "rp_plain", fields: ALL_TYPES, access: { read: () => true } };
const rp_hooked: CollectionConfig = {
  slug: "rp_hooked",
  fields: [
    ...ALL_TYPES.filter((f) => f.name !== "calculado" && f.name !== "num"),
    { name: "num", type: "number", access: { read: ({ doc }) => doc?.oculto === undefined } },
    {
      name: "calculado",
      type: "text",
      virtual: true,
      hooks: { afterRead: [({ data }) => `${data.texto}!`] },
    },
  ],
  hooks: {
    beforeRead: [({ doc }) => {
      doc.extra = "z";
    }],
    afterRead: [({ doc }) => doc.flag ? { ...doc, aaa: 1, expand: { tag: { b: 1, a: 2 } } } : undefined],
  },
  access: { read: () => true },
};
const rp_users: CollectionConfig = {
  slug: "rp_users",
  auth: { manage: ({ user }) => user?.id === "manager" },
  fields: [{ name: "nome", type: "text" }, { name: "pin", type: "text", hidden: true }],
  access: { read: () => true },
};
registerCollections(rp_tags, rp_plain, rp_hooked, rp_users);

async function setup() {
  const db = await dbWith([rp_tags, rp_plain, rp_hooked, rp_users]);
  const store = createStore(db);
  sql.insert(db, rp_tags, "tag000000000001", { nome: "um" });
  sql.insert(db, rp_tags, "tag000000000002", { nome: "dois" });
  const full = {
    texto: "olá",
    mail: "a@b.c",
    num: 1.5,
    inteiro: 7,
    flag: true,
    quando: "2026-10-07 12:00:00.000Z",
    dados: { b: 1, a: [1, { z: null }] },
    opcao: "a",
    opcoes: ["b", "a"],
    tag: "tag000000000001",
    tags: ["tag000000000002", "tag000000000001", "missing00000000"],
    anexo: "f.png",
    anexos: ["x.png", "y.png"],
    oculto: "segredo",
  };
  for (const c of [rp_plain, rp_hooked]) {
    sql.insert(db, c, "full00000000001", full);
    // Nothing set: every column NULL, so each type shows its PB zero value.
    sql.insert(db, c, "empty0000000001", {});
    sql.insert(db, c, "falsy0000000001", { texto: "", num: 0, flag: false, dados: [], opcoes: [], tags: [] });
  }
  sql.insert(db, rp_users, "user00000000001", {
    email: "x@y.z",
    passwordHash: "h",
    tokenKey: "k",
    emailVisibility: false,
    verified: true,
    nome: "Ana",
    pin: "1234",
  });
  sql.insert(db, rp_users, "user00000000002", { email: "v@y.z", emailVisibility: true, passwordHash: "h" });
  return { db, store };
}

/** assertEquals ignores key order; PB's JSON does not. Compare both. */
function same(actual: unknown, expected: unknown, msg: string) {
  assertEquals(actual, expected, msg);
  assertEquals(JSON.stringify(actual), JSON.stringify(expected), `${msg} (key order)`);
}

const principals: [string, AuthUser | null][] = [
  ["guest", null],
  ["user", { id: "user00000000001", collection: "rp_users", record: { id: "user00000000001" } }],
  ["manager", { id: "manager", collection: "rp_users", record: { id: "manager" } }],
  ["superuser", { id: "su", collection: "_superusers", record: { id: "su" } }],
];
const optionSets: Opts[] = [
  {},
  { override: true, showHidden: true },
  { showHidden: true },
  { override: true },
  { expand: "tag,tags" },
  { expand: "tag", fields: "id,tag,expand.tag.nome" },
  { fields: "*,expand" },
  { fields: "texto,oculto,email,collectionName" },
];

Deno.test("row decoder matches the per-field decode for every field type, NULLs and falsy values", async () => {
  const { db } = await setup();
  for (const c of [rp_plain, rp_hooked, rp_users, rp_tags]) {
    const rows = db.prepare(`SELECT * FROM "${c.slug}" ORDER BY id`).all() as Record<string, unknown>[];
    for (const row of rows) same(sql.decode(c, row), refDecode(c, row), `${c.slug} ${row.id}`);
  }
});

Deno.test("present matches the reference for every principal, option set and collection shape", async () => {
  const { db, store } = await setup();
  for (const c of [rp_plain, rp_hooked, rp_users]) {
    const raws = sql.findMany(db, c, { orderBy: [{ field: "id" }] });
    for (const [who, user] of principals) {
      const req = makeReq(store, user);
      for (const opts of optionSets) {
        for (const raw of raws) {
          const before = structuredClone(raw);
          const got = await present(req, c, raw, opts);
          same(raw, before, `${c.slug} ${raw.id} raw untouched`);
          same(got, await refPresent(req, c, raw, opts), `${c.slug} ${raw.id} as ${who} ${JSON.stringify(opts)}`);
        }
      }
    }
  }
});

Deno.test("list and count answer the same without DISTINCT on join-free queries", async () => {
  const { db, store } = await setup();
  const req = makeReq(store, null);
  for (const filter of ["", "flag = true", "tag.nome = 'um'", "tags.nome ?= 'dois'", "num > 0 || texto = ''"]) {
    const r = await find({ collection: "rp_plain", req, filter, sort: "-num,id", perPage: 50 });
    const ids = (db.prepare(`SELECT id FROM rp_plain`).all() as { id: string }[]).map((x) => x.id);
    // Every page item is a distinct row, and the total agrees with the items (one page holds them all).
    assertEquals(new Set(r.items.map((d) => d.id)).size, r.items.length, filter);
    assertEquals(r.totalItems, r.items.length, filter);
    assertEquals(r.items.every((d) => ids.includes(d.id)), true, filter);
  }
  // A hasMany join fans out (full points at tag 1 twice over tags + tag): DISTINCT stays and dedupes.
  const joined = await find({ collection: "rp_plain", req, filter: "tags.nome ?= 'um' || tags.nome ?= 'dois'" });
  assertEquals(joined.items.map((d) => d.id), ["full00000000001"]);
  assertEquals(joined.totalItems, 1);
});

Deno.test("decoder and present recompile when the collection's fields change", async () => {
  const { db, store } = await setup();
  const c: CollectionConfig = { slug: "rp_plain", fields: rp_plain.fields, access: { read: () => true } };
  const row = db.prepare(`SELECT * FROM rp_plain WHERE id = 'full00000000001'`).get() as Record<string, unknown>;
  same(sql.decode(c, row), refDecode(c, row), "first shape");
  c.fields = c.fields.filter((f) => f.name !== "dados");
  same(sql.decode(c, row), refDecode(c, row), "fields swapped");
  c.fields.push({ name: "dados", type: "text" });
  same(sql.decode(c, row), refDecode(c, row), "field pushed in place");
  const req = makeReq(store, null);
  const raw = sql.decode(c, row);
  same(await present(req, c, raw, {}), await refPresent(req, c, raw, {}), "present after change");
});
