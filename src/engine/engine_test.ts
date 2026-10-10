import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { type CollectionConfig, type Doc, type Field, LOCKED, type Where } from "../core/types.ts";
import { ApiError } from "../core/errors.ts";
import { quoteIdent } from "../schema/mod.ts";
import { create, find, findById, makeReq, overrideDeps, remove, update } from "./mod.ts";
import { orderByToSql } from "../store/query.ts";
import { createStore } from "../store/mod.ts";

Deno.env.set("BCRYPT_COST", "4");
const PW = "secret123";

// Fakes for schema/query so engine behaviour is pinned independently of sibling modules.
function toDb(f: Field, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (f.type === "json" || ("hasMany" in f && f.hasMany)) return JSON.stringify(v);
  if (f.type === "checkbox") return v ? 1 : 0;
  return v;
}
function fromDb(f: Field, v: unknown): unknown {
  if (v === null || v === undefined) return f.type === "checkbox" ? false : null;
  if (f.type === "json" || ("hasMany" in f && f.hasMany)) return JSON.parse(String(v));
  if (f.type === "checkbox") return v === 1;
  return v;
}
function whereToSql(_c: CollectionConfig, w: Where): { sql: string; params: (string | number | null)[]; joins: [] } {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (k === "and" || k === "or") {
      const subs = (v as Where[]).map((x) => whereToSql(_c, x));
      parts.push(`(${subs.map((s) => s.sql).join(k === "and" ? " AND " : " OR ")})`);
      subs.forEach((s) => params.push(...s.params));
    } else {
      const op = v as { equals?: string };
      parts.push(`${quoteIdent(k)} = ?`);
      params.push(op.equals as string);
    }
  }
  return { sql: parts.join(" AND ") || "1=1", params, joins: [] };
}

const log: string[] = [];
const cargos: CollectionConfig = {
  slug: "cargos",
  fields: [
    { name: "titulo", type: "text", required: true, unique: true },
    { name: "funcoes", type: "json", defaultValue: [] },
    {
      name: "segredo",
      type: "text",
      access: { read: ({ user }) => user?.id === "u1", update: ({ user }) => user?.id === "u1" },
    },
    {
      name: "rotulo",
      type: "text",
      virtual: true,
      hooks: { afterRead: [({ data }) => `#${data.titulo}`] },
    },
  ],
  access: {
    read: ({ user }) => (user ? true : { titulo: { equals: "publico" } }),
    create: ({ user }) => !!user,
    update: ({ user }) => (user ? { titulo: { equals: "editavel" } } : false),
    delete: ({ user }) => !!user,
  },
  hooks: {
    beforeValidate: [({ data }) => {
      log.push("c.beforeValidate");
      if (typeof data.titulo === "string") return { ...data, titulo: data.titulo.trim() };
    }],
    beforeChange: [() => void log.push("c.beforeChange")],
    afterChange: [({ doc }) => {
      log.push("c.afterChange");
      if (doc.titulo === "boom") throw new ApiError(400, "boom");
    }],
    beforeRead: [() => void log.push("c.beforeRead")],
    afterRead: [() => void log.push("c.afterRead")],
    beforeDelete: [() => void log.push("c.beforeDelete")],
    afterDelete: [() => void log.push("c.afterDelete")],
  },
};
cargos.fields[0].hooks = {
  beforeValidate: [({ value }) => void log.push(`f.beforeValidate:${value}`)],
  beforeChange: [() => void log.push("f.beforeChange")],
};
const users: CollectionConfig = {
  slug: "users",
  auth: true,
  fields: [{ name: "cargo", type: "relationship", relationTo: "cargos", required: true }],
  access: { read: () => true },
};

// PB nil rules (superusers only) against rules that match nothing: the two answer differently.
const cofre: CollectionConfig = {
  slug: "cofre",
  fields: [{ name: "titulo", type: "text" }],
  access: { read: LOCKED, create: LOCKED },
};
const negado: CollectionConfig = {
  slug: "negado",
  fields: [{ name: "titulo", type: "text" }],
  access: { read: () => false, create: () => false, update: () => false, delete: () => false },
};
// PB listRule "" with viewRule nil: a fn returns LOCKED for the call that carries an id.
const catalogo: CollectionConfig = {
  slug: "catalogo",
  fields: [{ name: "titulo", type: "text" }],
  access: { read: ({ id }) => (id ? LOCKED : true) },
};

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE cargos (id TEXT PRIMARY KEY, created TEXT, updated TEXT, titulo TEXT UNIQUE, funcoes TEXT,
    segredo TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, created TEXT, updated TEXT, email TEXT UNIQUE, passwordHash TEXT,
    tokenKey TEXT, verified INTEGER, cargo TEXT REFERENCES cargos(id));
    CREATE TABLE cofre (id TEXT PRIMARY KEY, created TEXT, updated TEXT, titulo TEXT);
    CREATE TABLE negado (id TEXT PRIMARY KEY, created TEXT, updated TEXT, titulo TEXT);
    CREATE TABLE catalogo (id TEXT PRIMARY KEY, created TEXT, updated TEXT, titulo TEXT);`);
  const store = createStore(db);
  const restore = overrideDeps({
    toDb,
    fromDb,
    whereToSql,
    tableName: (s) => s,
    orderByToSql,
    collections: () => [cargos, users, cofre, negado, catalogo],
  });
  log.length = 0;
  const u1 = { id: "u1", collection: "users", record: { id: "u1" } };
  return {
    db,
    restore,
    anon: makeReq(store),
    user: makeReq(store, u1),
    other: makeReq(store, { id: "u2", collection: "users", record: { id: "u2" } }),
    su: makeReq(store, { id: "s", collection: "_superusers", record: { id: "s" } }),
  };
}
const status = async (p: Promise<unknown>) => ((await assertRejects(() => p)) as ApiError).status;

Deno.test("create runs hooks in order inside tx and fills defaults and virtuals", async () => {
  const t = setup();
  try {
    // created/updated cannot be forged; a malformed client id is refused before any hook (see batch_test).
    const doc = await create({ collection: "cargos", req: t.user, data: { titulo: " a ", created: "forged" } });
    assertEquals(log, [
      "f.beforeValidate: a ",
      "c.beforeValidate",
      "f.beforeChange",
      "c.beforeChange",
      "c.afterChange",
      "c.beforeRead",
      "c.afterRead",
    ]);
    assertEquals([doc.titulo, doc.funcoes, doc.rotulo, doc.created === "forged"], ["a", [], "#a", false]);
  } finally {
    t.restore();
  }
});

Deno.test("afterChange failure rolls back the insert", async () => {
  const t = setup();
  try {
    await assertRejects(() => create({ collection: "cargos", req: t.user, data: { titulo: "boom" } }));
    assertEquals(t.db.prepare("SELECT COUNT(*) n FROM cargos").get(), { n: 0 });
  } finally {
    t.restore();
  }
});

Deno.test("validation and uniqueness report PB per-field errors", async () => {
  const t = setup();
  try {
    let e = await assertRejects(() => create({ collection: "cargos", req: t.user, data: {} }), ApiError);
    assertEquals([e.status, e.data.titulo.code], [400, "validation_required"]);
    await create({ collection: "cargos", req: t.user, data: { titulo: "x" } });
    e = await assertRejects(() => create({ collection: "cargos", req: t.user, data: { titulo: "x" } }), ApiError);
    assertEquals(e.data.titulo.code, "validation_not_unique");
    e = await assertRejects(
      () =>
        create({
          collection: "users",
          req: t.su,
          data: { email: "a@b.co", cargo: "nope", password: PW, passwordConfirm: PW },
        }),
      ApiError,
    );
    assertEquals(e.data.cargo.code, "validation_missing_rel_records");
  } finally {
    t.restore();
  }
});

Deno.test("create access: a rejecting rule is PB's 400, superuser bypasses missing rule", async () => {
  const t = setup();
  try {
    const e = await assertRejects(() => create({ collection: "cargos", req: t.anon, data: { titulo: "x" } }), ApiError);
    assertEquals([e.status, e.message], [400, "Failed to create record."]);
    const c = await create({ collection: "cargos", req: t.su, data: { titulo: "x" } });
    const u = await create({
      collection: "users",
      req: t.su,
      data: { email: "a@b.co", cargo: c.id, password: PW, passwordConfirm: PW, passwordHash: "forged" },
    });
    assertEquals([u.passwordHash, u.tokenKey, u.email], [undefined, undefined, "a@b.co"]);
    const hidden = await findById({ collection: "users", req: t.su, id: u.id, showHidden: true });
    // Clients cannot write the hash; the plain password is hashed instead.
    assert(String(hidden.passwordHash).startsWith("$2"));
    assert(hidden.tokenKey);
  } finally {
    t.restore();
  }
});

Deno.test("read access Where is ANDed into find and findById hides with 404", async () => {
  const t = setup();
  try {
    const pub = await create({ collection: "cargos", req: t.su, data: { titulo: "publico" } });
    const priv = await create({ collection: "cargos", req: t.su, data: { titulo: "b" } });
    const anon = await find({ collection: "cargos", req: t.anon });
    assertEquals(anon.items.map((d) => d.id), [pub.id]);
    assertEquals(await status(findById({ collection: "cargos", req: t.anon, id: priv.id })), 404);
    const filtered = await find({ collection: "cargos", req: t.user, filter: "titulo='b'", sort: "-titulo" });
    assertEquals(filtered.items.map((d) => d.id), [priv.id]);
    const paged = await find({ collection: "cargos", req: t.user, perPage: 1, page: 2, sort: "titulo" });
    assertEquals([paged.totalItems, paged.totalPages, paged.items[0].titulo], [2, 2, "publico"]);
  } finally {
    t.restore();
  }
});

Deno.test("field read/update access strips or drops fields; superuser bypasses", async () => {
  const t = setup();
  try {
    const c = await create({ collection: "cargos", req: t.su, data: { titulo: "editavel", segredo: "s1" } });
    assertEquals((await findById({ collection: "cargos", req: t.other, id: c.id })).segredo, undefined);
    assertEquals((await findById({ collection: "cargos", req: t.user, id: c.id })).segredo, "s1");
    await update({ collection: "cargos", req: t.other, id: c.id, data: { segredo: "s2" } });
    assertEquals((await findById({ collection: "cargos", req: t.su, id: c.id })).segredo, "s1");
    await update({ collection: "cargos", req: t.user, id: c.id, data: { segredo: "s3" } });
    assertEquals((await findById({ collection: "cargos", req: t.su, id: c.id })).segredo, "s3");
  } finally {
    t.restore();
  }
});

Deno.test("update Where access 404s outside and when the rule rejects; validates merged doc", async () => {
  const t = setup();
  try {
    const ok = await create({ collection: "cargos", req: t.su, data: { titulo: "editavel" } });
    const no = await create({ collection: "cargos", req: t.su, data: { titulo: "fixo" } });
    assertEquals(await status(update({ collection: "cargos", req: t.user, id: no.id, data: { funcoes: [1] } })), 404);
    // PB hides the row (404) from a rule that rejects, even when it exists.
    assertEquals(await status(update({ collection: "cargos", req: t.anon, id: ok.id, data: {} })), 404);
    assertEquals(await status(update({ collection: "cargos", req: t.user, id: ok.id, data: { titulo: "" } })), 400);
    const d = await update({ collection: "cargos", req: t.user, id: ok.id, data: { funcoes: ["x"] } });
    assertEquals([d.titulo, d.funcoes], ["editavel", ["x"]]);
  } finally {
    t.restore();
  }
});

Deno.test("remove runs delete hooks; beforeDelete throw rolls back", async () => {
  const t = setup();
  try {
    const c = await create({ collection: "cargos", req: t.su, data: { titulo: "x" } });
    log.length = 0;
    await remove({ collection: "cargos", req: t.user, id: c.id });
    assertEquals(log, ["c.beforeDelete", "c.afterDelete"]);
    assertEquals(await status(remove({ collection: "cargos", req: t.user, id: c.id })), 404);
  } finally {
    t.restore();
  }
});

Deno.test("expand and fields follow PB shape", async () => {
  const t = setup();
  try {
    const c = await create({ collection: "cargos", req: t.su, data: { titulo: "x" } });
    const u = await create({
      collection: "users",
      req: t.su,
      data: { email: "a@b.co", cargo: c.id, password: PW, passwordConfirm: PW },
    });
    const d = await findById({
      collection: "users",
      req: t.user,
      id: u.id,
      expand: "cargo",
      fields: "id,expand.cargo.titulo",
    });
    assertEquals(d, { id: u.id, expand: { cargo: { titulo: "x" } } } as unknown);
  } finally {
    t.restore();
  }
});

Deno.test("a list expands a related id shared by its items once, each item with its own copy", async () => {
  const t = setup();
  try {
    const c = await create({ collection: "cargos", req: t.su, data: { titulo: "x" } });
    for (const email of ["a@b.co", "c@d.co", "e@f.co"]) {
      await create({ collection: "users", req: t.su, data: { email, cargo: c.id, password: PW, passwordConfirm: PW } });
    }
    const seen: string[] = [];
    // Statements are cached by the store, so count runs on the prototype, not prepares.
    const proto = StatementSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const originais = Object.fromEntries(["get", "all", "iterate"].map((m) => [m, proto[m]]));
    for (const [m, f] of Object.entries(originais)) {
      proto[m] = function (this: StatementSync, ...a: unknown[]) {
        seen.push(this.sourceSQL);
        return f.apply(this, a);
      };
    }
    let r;
    try {
      r = await find({ collection: "users", req: t.su, expand: "cargo" });
    } finally {
      Object.assign(proto, originais);
    }
    assertEquals(r.items.map((u) => (u.expand as { cargo: Doc }).cargo.titulo), ["x", "x", "x"]);
    assertEquals(seen.filter((q) => /FROM\s+"?cargos"?/.test(q)).length, 1);
    const [a, b] = r.items.map((u) => (u.expand as { cargo: Doc }).cargo);
    assert(a !== b);
  } finally {
    t.restore();
  }
});

Deno.test("PB parity: a locked op is 403 for guest and user; superuser passes", async () => {
  const t = setup();
  try {
    const d = await create({ collection: "cofre", req: t.su, data: { titulo: "x" } });
    const ops = (req: typeof t.anon) => [
      find({ collection: "cofre", req }),
      findById({ collection: "cofre", req, id: d.id }),
      create({ collection: "cofre", req, data: { titulo: "y" } }),
      update({ collection: "cofre", req, id: d.id, data: { titulo: "z" } }),
      remove({ collection: "cofre", req, id: d.id }),
    ];
    for (const req of [t.anon, t.user]) {
      for (const p of ops(req)) {
        const e = await assertRejects(() => p, ApiError);
        assertEquals([e.status, e.message], [403, "Only superusers can perform this action."]);
      }
    }
    assertEquals((await find({ collection: "cofre", req: t.su })).totalItems, 1);
  } finally {
    t.restore();
  }
});

Deno.test("PB parity: a rule that rejects is list 200 empty, view/update/delete 404, create 400", async () => {
  const t = setup();
  try {
    const d = await create({ collection: "negado", req: t.su, data: { titulo: "x" } });
    for (const req of [t.anon, t.user]) {
      assertEquals(await find({ collection: "negado", req }), {
        page: 1,
        perPage: 30,
        totalItems: 0,
        totalPages: 0,
        items: [],
      });
      for (
        const p of [
          findById({ collection: "negado", req, id: d.id }),
          update({ collection: "negado", req, id: d.id, data: { titulo: "z" } }),
          remove({ collection: "negado", req, id: d.id }),
        ]
      ) {
        const e = await assertRejects(() => p, ApiError);
        assertEquals([e.status, e.message], [404, "The requested resource wasn't found."]);
      }
      const e = await assertRejects(() => create({ collection: "negado", req, data: { titulo: "y" } }), ApiError);
      assertEquals([e.status, e.message], [400, "Failed to create record."]);
    }
  } finally {
    t.restore();
  }
});

Deno.test("PB parity: a fn returning LOCKED is the nil rule for that call (list open, view 403)", async () => {
  const t = setup();
  try {
    const d = await create({ collection: "catalogo", req: t.su, data: { titulo: "x" } });
    for (const req of [t.anon, t.user]) {
      assertEquals((await find({ collection: "catalogo", req })).totalItems, 1);
      const e = await assertRejects(() => findById({ collection: "catalogo", req, id: d.id }), ApiError);
      assertEquals([e.status, e.message], [403, "Only superusers can perform this action."]);
    }
    assertEquals((await findById({ collection: "catalogo", req: t.su, id: d.id })).titulo, "x");
  } finally {
    t.restore();
  }
});
