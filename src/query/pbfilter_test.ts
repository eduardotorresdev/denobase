import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { ApiError } from "../core/errors.ts";
import { registerCollections } from "../core/registry.ts";
import type { AuthUser, CollectionConfig } from "../core/types.ts";
import { find, makeReq } from "../engine/mod.ts";
import { dbWith } from "../testing/mod.ts";
import { compilePb, type FilterContext, likePattern, parsePbSort, type RequestInfo } from "./mod.ts";

// Cases of PB's filter, token functions, identifier macros and record field resolver tests, asserted on rows of a real SQLite db instead of PB's exact SQL text.

const pf_tags = defineCollection({
  slug: "pf_tags",
  fields: [{ name: "name", type: "text" }, { name: "parent", type: "relationship", relationTo: "pf_tags" }],
  access: { read: () => true },
});
const pf_secret = defineCollection({ slug: "pf_secret", fields: [{ name: "title", type: "text" }] });
const pf_ruled = defineCollection({
  slug: "pf_ruled",
  fields: [{ name: "title", type: "text" }, { name: "public", type: "checkbox" }],
  access: { read: () => ({ public: { equals: true } }) },
});
const pf_users = defineCollection({
  slug: "pf_users",
  auth: true,
  fields: [
    { name: "name", type: "text" },
    { name: "age", type: "number" },
    { name: "data", type: "json" },
    { name: "roles", type: "select", options: ["a", "b"], hasMany: true },
    { name: "mainTag", type: "relationship", relationTo: "pf_tags" },
    { name: "tags", type: "relationship", relationTo: "pf_tags", hasMany: true },
    { name: "secret", type: "relationship", relationTo: "pf_secret" },
    { name: "ruled", type: "relationship", relationTo: "pf_ruled" },
    { name: "note", type: "text", hidden: true },
  ],
  access: { read: () => true },
});
const pf_posts = defineCollection({
  slug: "pf_posts",
  fields: [
    { name: "title", type: "text" },
    { name: "views", type: "number" },
    { name: "published", type: "date" },
    { name: "author", type: "relationship", relationTo: "pf_users" },
    { name: "authors", type: "relationship", relationTo: "pf_users", hasMany: true },
    { name: "uniqueAuthor", type: "relationship", relationTo: "pf_users", unique: true },
    { name: "lon", type: "number" },
    { name: "lat", type: "number" },
  ],
  access: { read: () => true },
});
const ALL = [pf_tags, pf_secret, pf_ruled, pf_users, pf_posts];
registerCollections(...ALL);

const SU: AuthUser = { id: "su", collection: "_superusers", record: { id: "su", email: "su@x.io" } };
const U1: AuthUser = { id: "u1", collection: "pf_users", record: { id: "u1", name: "Ana" } };

async function setup() {
  const db = await dbWith(ALL);
  db.exec(`
    INSERT INTO pf_tags (id, created, updated, name, parent) VALUES
      ('t1','2024-01-01','2024-01-01','red',NULL), ('t2','2024-01-01','2024-01-01','blue','t1'),
      ('t3','2024-01-01','2024-01-01','green','t2');
    INSERT INTO pf_secret (id, created, updated, title) VALUES ('s1','2024','2024','s');
    INSERT INTO pf_ruled (id, created, updated, title, public) VALUES ('r1','2024','2024','r1',1), ('r2','2024','2024','r2',0);
    INSERT INTO pf_users (id, created, updated, email, emailVisibility, verified, passwordHash, tokenKey,
      name, age, data, roles, mainTag, tags, secret, ruled, note) VALUES
      ('u1','2024-01-01 10:00:00.000Z','2024','a@x.com',1,1,'h','k','Ana',30,'{"a":1,"b":{"c":"x"}}','["a","b"]',
        't1','["t1","t2"]','s1','r1','n1'),
      ('u2','2024-02-01 10:00:00.000Z','2024','b@x.com',0,0,'h','k','Bia',20,'{"a":2}','["b"]','t2','["t2"]',NULL,
        'r2',NULL),
      ('u3','2024-03-01 10:00:00.000Z','2024','c@x.com',0,0,'h','k',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO pf_posts (id, created, updated, title, views, published, author, authors, uniqueAuthor, lon, lat)
    VALUES
      ('p1','2024','2024','Hello',10,'2020-05-01 00:00:00.000Z','u1','["u1","u2"]','u1',0,0),
      ('p2','2024','2024','World',30,'2999-01-01 00:00:00.000Z','u1','["u1"]',NULL,0,1),
      ('p3','2024','2024','Other',20,NULL,'u2','[]','u2',10,10);
  `);
  const app = createApp({ db, mailer: new MemoryMailer() });
  return { db, app, store: app.store };
}

type Setup = Awaited<ReturnType<typeof setup>>;

interface Opts {
  user?: AuthUser | null;
  sort?: string;
  requestInfo?: Partial<Omit<RequestInfo, "auth">>;
}

/** Ids through engine.find (the REST list path); unsorted calls come back ordered by id. */
async function ids(t: Setup, collection: string, filter: string | undefined, o: Opts = {}): Promise<string[]> {
  const req = makeReq(t.store, o.user === undefined ? SU : o.user);
  const r = await find({ collection, req, filter, sort: o.sort, perPage: 100, requestInfo: o.requestInfo });
  const out = r.items.map((d) => d.id);
  return o.sort ? out : out.sort();
}

const status = async (p: Promise<unknown>) => ((await assertRejects(() => p, ApiError)) as ApiError).status;

/** Rows of a filter compiled directly, for contexts REST cannot reach (non-superuser @request, pinned clock). */
function run(db: DatabaseSync, c: CollectionConfig, filter: string, ctx: Partial<FilterContext> = {}): string[] {
  const f = compilePb(c, { filter }, { collections: ALL, allowHidden: true, ...ctx });
  const sql = `SELECT DISTINCT ${c.slug}.id AS id FROM ${c.slug} ${f.joins.join(" ")} WHERE ${f.where} ORDER BY 1`;
  return db.prepare(sql).all(...f.joinParams, ...f.params).map((r) => String(r.id));
}

const request = (o: Partial<RequestInfo> = {}): RequestInfo => ({
  context: "default",
  method: "GET",
  query: {},
  headers: {},
  body: {},
  auth: null,
  ...o,
});

Deno.test("operators compare like PB, nulls read as zero values", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "name = 'Ana'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name != 'Ana'"), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "name ~ 'an'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name !~ 'an'"), ["u2", "u3"]);
  // ~ ignores case and accents beyond ASCII: SQLite's LIKE alone would miss both.
  assertEquals(await ids(t, "pf_users", "name ~ 'ÂN'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name ~ 'bí%'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "name !~ 'ÁNA'"), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "age > 20"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "age >= 20"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "age < 21"), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "age <= 0"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "25 < age"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "verified = true"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "verified = false"), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "name = name"), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "name = 'Ana' || name = 'Bia' && age > 25"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "(name = 'Ana' || name = 'Bia') && age < 25"), ["u2"]);
});

Deno.test("empty string and null are the same value (resolveEqualExpr)", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "name = null"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "name = ''"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "'' = name"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "name != null"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "null = ''"), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "'' != null"), []);
  const f = compilePb(pf_users, { filter: "name = ''" }, { collections: ALL });
  assert(f.where.includes("= '' OR") && f.where.includes("IS NULL"), f.where);
  assertEquals(f.params, []);
});

Deno.test("like escapes wildcards unless the value has an unescaped % (wrapLikeParams)", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "name ~ 'A%'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name ~ '_'"), []);
  assertEquals(await ids(t, "pf_users", "'xAnax' ~ name"), ["u1", "u3"]);
  const cases: [string, string][] = [
    ["abc", "%abc%"],
    ["ab%c", "ab%c"],
    ["ab\\%c", "%ab\\%c%"],
    ["%ab\\%c", "%ab\\%c"],
    ["ab\\\\%c", "ab\\\\%c"],
    ["ab\\\\\\%c", "%ab\\\\\\%c%"],
    ["ab_c", "%ab\\_c%"],
    ["ab\\_c", "%ab\\_c%"],
    ["%ab_c", "%ab_c"],
    ["ab\\c", "%ab\\\\c%"],
    ["_ab\\c_", "%\\_ab\\\\c\\_%"],
    ["ab\\c%", "ab\\c%"],
    ["a\nb\\", "%a\nb\\\\%"],
  ];
  for (const [input, want] of cases) assertEquals(likePattern(input), want, input);
});

Deno.test("single relations join once, rel.id needs no join", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "mainTag.name = 'red'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "mainTag = 't2'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "mainTag.id = 't2'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "mainTag.parent.name = 'red'"), ["u2"]);
  assertEquals(await ids(t, "pf_posts", "author.mainTag.name = 'blue'"), ["p3"]);
  assertEquals(compilePb(pf_users, { filter: "mainTag.id = 't2'" }, { collections: ALL }).joins, []);
  const twice = compilePb(pf_users, { filter: "mainTag.name = 'red' && mainTag.name != 'x'" }, {
    collections: ALL,
    allowHidden: true,
  });
  assertEquals(twice.joins.length, 1);
  assertEquals(await ids(t, "pf_tags", "parent.parent.parent.parent.parent.parent.name = 'x'"), []);
  assertEquals(await status(ids(t, "pf_tags", "parent.parent.parent.parent.parent.parent.parent.name = 'x'")), 400);
  assertEquals(await status(ids(t, "pf_users", "name.x = 1")), 400);
  assertEquals(await status(ids(t, "pf_users", "nope = 1")), 400);
});

Deno.test("hasMany relations multi-match (all items) unless the ?-operator asks for any", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "tags.name = 'blue'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "tags.name ?= 'blue'"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "tags.name != 'red'"), ["u2", "u3"]);
  // u3 has no tags: its LEFT JOIN row is NULL, and NULL IS NOT 'red' holds (same in PB).
  assertEquals(await ids(t, "pf_users", "tags.name ?!= 'red'"), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "tags.name ?~ 'ue'"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "tags.name ~ 'e'"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_posts", "authors.name ?= 'Bia'"), ["p1"]);
  assertEquals(await ids(t, "pf_posts", "authors.age > 25"), ["p2"]);
  assertEquals(await ids(t, "pf_posts", "authors.age ?> 25"), ["p1", "p2"]);
  // many vs many: every tag name against every tag id; u3's missing tags are NULL on both sides, so equal
  assertEquals(await ids(t, "pf_users", "tags.name != tags.id"), ["u1", "u2"]);
  const mm = compilePb(pf_users, { filter: "tags.name = 'x'" }, { collections: ALL, allowHidden: true });
  assert(mm.where.includes("NOT EXISTS"), mm.where);
  const any = compilePb(pf_users, { filter: "tags.name ?= 'x'" }, { collections: ALL, allowHidden: true });
  assert(!any.where.includes("NOT EXISTS"), any.where);
});

Deno.test(":each, :length and :lower modifiers", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "roles:each = 'b'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "roles:each ?= 'a'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "roles ~ 'a'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "roles:length = 2"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "roles:length = 0"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "tags:length > 0"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "mainTag:length = 1"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_posts", "authors.tags:length ?= 1"), ["p1"]);
  assertEquals(await ids(t, "pf_users", "name:lower = 'ana'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "mainTag.name:lower ~ 'RE'"), ["u1"]);
  assertEquals(await status(ids(t, "pf_users", "name:nope = 1")), 400);
});

Deno.test("json fields compare their extracted values without the null fallback", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "data.a = 1"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "data.a > 1"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "data.b.c = 'x'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "data = null"), ["u3"]);
  assertEquals(await ids(t, "pf_users", "data.missing = null"), ["u1", "u2", "u3"]);
  const f = compilePb(pf_users, { filter: "data.a = data.b" }, { collections: ALL });
  assert(f.where.includes(" IS "), f.where);
});

Deno.test("back relations: <collection>_via_<field>", async () => {
  const t = await setup();
  // single relation without unique index -> multi-match over all posts of the user
  assertEquals(await ids(t, "pf_users", "pf_posts_via_author.title = 'Hello'"), []);
  assertEquals(await ids(t, "pf_users", "pf_posts_via_author.title ?= 'Hello'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "pf_posts_via_author.views > 5"), ["u1", "u2"]);
  // hasMany back relation
  assertEquals(await ids(t, "pf_users", "pf_posts_via_authors.title ?= 'Hello'"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", "pf_posts_via_authors.title = 'Hello'"), ["u2"]);
  // unique single relation -> plain comparison
  assertEquals(await ids(t, "pf_users", "pf_posts_via_uniqueAuthor.title = 'Hello'"), ["u1"]);
  const u = compilePb(pf_users, { filter: "pf_posts_via_uniqueAuthor.title = 'x'" }, { collections: ALL });
  assert(!u.where.includes("NOT EXISTS"), u.where);
  assertEquals(await status(ids(t, "pf_users", "pf_posts_via_title.id = 'x'")), 400);
  assertEquals(await status(ids(t, "pf_users", "pf_tags_via_parent.id = 'x'")), 400);
});

Deno.test("@collection joins, with and without alias", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "@collection.pf_tags.name ?= 'green'"), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@collection.pf_tags.name = 'green'"), []);
  assertEquals(
    await ids(t, "pf_users", "@collection.pf_tags:t.name ?= 'red' && @collection.pf_tags:t.id ?= mainTag"),
    ["u1"],
  );
  assertEquals(await ids(t, "pf_users", "@collection.pf_posts.author ?= id && @collection.pf_posts.views ?> 25"), [
    "u1",
  ]);
  assertEquals(await status(ids(t, "pf_users", "@collection.nope.id ?= 'x'")), 400);
});

Deno.test("@request.* static fields, :isset, number casting and body modifiers", async () => {
  const t = await setup();
  const ri = (o: Opts["requestInfo"]) => ({ requestInfo: o });
  assertEquals(await ids(t, "pf_users", "@request.method = 'GET' && @request.context = 'default'"), [
    "u1",
    "u2",
    "u3",
  ]);
  assertEquals(await ids(t, "pf_users", "@request.query.filter ~ 'query'"), ["u1", "u2", "u3"]);
  const q = { query: { x: "5", age: "30" }, headers: { x_k: "v" } };
  assertEquals(await ids(t, "pf_users", "@request.query.x = '5' && @request.headers.x_k = 'v'", ri(q)), [
    "u1",
    "u2",
    "u3",
  ]);
  assertEquals(await ids(t, "pf_users", "age = @request.query.age", ri(q)), ["u1"]);
  assertEquals(await ids(t, "pf_users", "@request.query.missing = null", ri(q)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.query.x:isset = true", ri(q)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.query.missing:isset = true", ri(q)), []);
  assertEquals(await status(ids(t, "pf_users", "@request.query.x:each = 1", ri(q))), 400);
  const body = { body: { name: "Ana", roles: ["a", "b"], mainTag: "t1", tags: ["t1", "t3"], other: { a: 1 } } };
  assertEquals(await ids(t, "pf_users", "name = @request.body.name", ri(body)), ["u1"]);
  assertEquals(await ids(t, "pf_users", "@request.body.name:changed = true", ri(body)), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.age:changed = true", ri(body)), []);
  assertEquals(await ids(t, "pf_users", "@request.body.roles:length = 2", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.roles:each ?= 'b'", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.roles:each = 'b'", ri(body)), []);
  assertEquals(await ids(t, "pf_users", "@request.body.name:lower = 'ana'", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.mainTag.name = mainTag.name", ri(body)), ["u1"]);
  assertEquals(await ids(t, "pf_users", "@request.body.tags.name ?= 'green'", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.other = '{\"a\":1}'", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "@request.body.missing.x = null", ri(body)), ["u1", "u2", "u3"]);
  assertEquals(await status(ids(t, "pf_users", "@request.body.name:length = 1", ri(body))), 400);
});

Deno.test("@request.auth: plain fields are values, others join the auth record", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "@request.auth.id = 'su' && @request.auth.collectionName = '_superusers'"), [
    "u1",
    "u2",
    "u3",
  ]);
  const auth = { collection: "pf_users", record: { id: "u2", name: "Bia" } };
  const as = (filter: string) => run(t.db, pf_users, filter, { request: request({ auth }) });
  assertEquals(as("id = @request.auth.id"), ["u2"]);
  assertEquals(as("mainTag = @request.auth.mainTag"), ["u2"]);
  assertEquals(as("@request.auth.mainTag.name = 'blue'"), ["u1", "u2", "u3"]);
  assertEquals(as("@request.auth.tags.name ?= tags.name"), ["u1", "u2"]);
  assertEquals(as("@request.auth.missing.x = null"), ["u1", "u2", "u3"]);
  const guest = (filter: string) => run(t.db, pf_users, filter, { request: request() });
  assertEquals(guest("@request.auth.id != ''"), []);
  assertEquals(guest("@request.auth.id = ''"), ["u1", "u2", "u3"]);
  assertEquals(guest("id = @request.auth.id"), []);
  // no request info at all (internal calls): every @request.* is NULL
  assertEquals(run(t.db, pf_users, "@request.method = null", { request: null }), ["u1", "u2", "u3"]);
});

Deno.test("datetime macros, pinned clock", () => {
  const now = () => new Date("2024-02-10T13:14:15.678Z");
  const want: Record<string, string | number> = {
    "@now": "2024-02-10 13:14:15.678Z",
    "@yesterday": "2024-02-09 13:14:15.678Z",
    "@tomorrow": "2024-02-11 13:14:15.678Z",
    "@second": 15,
    "@minute": 14,
    "@hour": 13,
    "@day": 10,
    "@month": 2,
    "@weekday": 6,
    "@year": 2024,
    "@todayStart": "2024-02-10 00:00:00.000Z",
    "@todayEnd": "2024-02-10 23:59:59.999Z",
    "@monthStart": "2024-02-01 00:00:00.000Z",
    "@monthEnd": "2024-02-29 23:59:59.999Z",
    "@yearStart": "2024-01-01 00:00:00.000Z",
    "@yearEnd": "2024-12-31 23:59:59.999Z",
  };
  for (const [macro, value] of Object.entries(want)) {
    const f = compilePb(pf_posts, { filter: `published > ${macro}` }, { collections: ALL, now });
    assertEquals(f.params, [value], macro);
  }
});

Deno.test("datetime macros and functions filter rows", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_posts", "published < @now"), ["p1", "p3"]);
  assertEquals(await ids(t, "pf_posts", "published > @now"), ["p2"]);
  assertEquals(await ids(t, "pf_posts", "strftime('%Y', published) = '2020'"), ["p1"]);
  assertEquals(await ids(t, "pf_posts", "strftime('%Y-%m', published, 'start of year', '+1 month') = '2020-02'"), [
    "p1",
  ]);
  assertEquals(await ids(t, "pf_posts", "strftime('%Y', published) = null"), ["p3"]);
  assertEquals(await ids(t, "pf_posts", "strftime('%Y', authors.created) ?= '2024'"), ["p1", "p2"]);
  assertEquals(await ids(t, "pf_posts", "strftime('%m', authors.created) = '01'"), ["p2"]);
  assertEquals(await ids(t, "pf_posts", "geoDistance(lon, lat, 0, 0) < 112 && geoDistance(lon, lat, 0, 0) > 110"), [
    "p2",
  ]);
  assertEquals(await ids(t, "pf_posts", "geoDistance(lon, lat, 0, 0) = 0"), ["p1"]);
  for (
    const bad of [
      "strftime() = 1",
      "strftime(1) = 1",
      "strftime('%Y', published, 1) = 1",
      "geoDistance(1,2,3) = 1",
      "geoDistance(1,2,3,'x') = 1",
      "nope(1) = 1",
      "strftime('%Y', strftime(strftime(strftime('%Y')))) = 1",
    ]
  ) {
    assertEquals(await status(ids(t, "pf_posts", bad)), 400, bad);
  }
});

Deno.test("grammar: comments, groups, numbers, escapes and errors (fexpr)", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "name = 'Ana' // trailing comment"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "// first\nname = 'Bia'"), ["u2"]);
  assertEquals(await ids(t, "pf_users", "((name = 'Ana') || (((age = 20))))"), ["u1", "u2"]);
  assertEquals(await ids(t, "pf_users", `name = "it's" || name = 'it\\'s'`), []);
  assertEquals(await ids(t, "pf_users", "age = -1 || age = 30.0"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name = NULL && age = FALSE"), ["u3"]);
  for (
    const bad of [
      "",
      "  ",
      "// only a comment",
      "(name = 'x'",
      "name = 'x')",
      "name = 'x",
      "name =",
      "name 'x'",
      "name == 'x'",
      "name + 1",
      "name = 1 &",
      "name = 1 && ",
      "name = 1.",
      "name = -",
      "name = 1\r",
      "()",
      "name. = 1",
      "@ = 1",
      "name = 1; DROP TABLE pf_users",
    ]
  ) {
    assertEquals(await status(ids(t, "pf_users", bad || " ")), 400, JSON.stringify(bad));
  }
  assertEquals(await ids(t, "pf_users", `name = "x' OR 1=1 --"`), []);
});

Deno.test("expression and length limits", async () => {
  const t = await setup();
  const exprs = (n: number) => Array.from({ length: n }, () => "1 = 1").join(" && ");
  assertEquals((await ids(t, "pf_users", exprs(200))).length, 3);
  assertEquals(await status(ids(t, "pf_users", exprs(201))), 400);
  assertEquals(await status(ids(t, "pf_users", `name = '${"x".repeat(3500)}'`)), 400);
});

Deno.test("hidden fields only for superusers; email only where visible for others", async () => {
  const t = await setup();
  assertEquals(await ids(t, "pf_users", "note = 'n1'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "passwordHash = 'h' && tokenKey = 'k'"), ["u1", "u2", "u3"]);
  for (const f of ["note = 'n1'", "passwordHash != ''", "tokenKey != ''", "pf_posts_via_author.id ?= note"]) {
    assertEquals(await status(ids(t, "pf_users", f, { user: U1 })), 400, f);
    assertEquals(await status(ids(t, "pf_users", f, { user: null })), 400, f);
  }
  assertEquals(await ids(t, "pf_users", "email ~ 'x.com'", { user: U1 }), ["u1"]);
  assertEquals(await ids(t, "pf_users", "email ~ 'x.com'"), ["u1", "u2", "u3"]);
  // realtime filters never see hidden fields, not even a superuser's (PB realtimeCanAccessRecord)
  const realtime = { context: "realtime" };
  assertEquals(await status(ids(t, "pf_users", "note = 'n1'", { requestInfo: realtime })), 400);
});

Deno.test("joined collections apply their read rule for non-superusers (listRuleJoins)", async () => {
  const t = await setup();
  assertEquals(await status(ids(t, "pf_users", "secret.title = 's'", { user: U1 })), 400);
  assertEquals(await ids(t, "pf_users", "secret.title = 's'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "ruled.title != 'zzz'", { user: U1 }), ["u1", "u3"]);
  assertEquals(await ids(t, "pf_users", "ruled.title != 'zzz'"), ["u1", "u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "ruled.title != 'zzz'", { sort: "ruled.title", user: U1 }), ["u3", "u1"]);
});

Deno.test("@collection and @request in client filter or sort are superuser-only (403)", async () => {
  const t = await setup();
  for (const user of [U1, null]) {
    const e = await assertRejects(() => ids(t, "pf_users", "@request.auth.id != ''", { user }), ApiError);
    assertEquals([e.status, e.message], [403, "Only superusers can filter by @request."]);
    const c = await assertRejects(() => ids(t, "pf_users", "@collection.pf_tags.id ?= 'x'", { user }), ApiError);
    assertEquals([c.status, c.message], [403, "Only superusers can filter by @collection."]);
    assertEquals(await status(ids(t, "pf_users", undefined, { user, sort: "@request.auth.id" })), 403);
  }
});

Deno.test("sort: directions, relation paths, @random, @rowid and PB's errors", async () => {
  const t = await setup();
  const s = (sort: string, user: AuthUser | null = SU) => ids(t, "pf_users", undefined, { sort, user });
  assertEquals(await s("-age"), ["u1", "u2", "u3"]);
  assertEquals(await s("+age"), ["u3", "u2", "u1"]);
  assertEquals(await s("age"), ["u3", "u2", "u1"]);
  assertEquals(await s("mainTag.name"), ["u3", "u2", "u1"]);
  assertEquals(await s("-mainTag.parent.name,id"), ["u2", "u1", "u3"]);
  assertEquals(await s("@rowid"), ["u1", "u2", "u3"]);
  assertEquals(await s("-@rowid"), ["u3", "u2", "u1"]);
  assertEquals((await s("@random")).sort(), ["u1", "u2", "u3"]);
  assertEquals(await s("data.a,-created"), ["u3", "u1", "u2"]);
  assertEquals(await s("roles:length,-name"), ["u3", "u2", "u1"]);
  assertEquals(await s("note,id"), ["u2", "u3", "u1"]);
  for (const bad of ["nope", "name,", ",name", "name;", "@request.auth.id", "null", "a".repeat(256)]) {
    assertEquals(await status(s(bad)), 400, bad);
  }
  assertEquals(await status(s("note", U1)), 400);
  assertEquals(await status(s(Array(9).fill("name").join(","))), 400);
  assertEquals(parsePbSort("-a, +b ,c"), [
    { name: "a", direction: "DESC" },
    { name: "b", direction: "ASC" },
    { name: "c", direction: "ASC" },
  ]);
});

Deno.test("store queries sort through relation paths too", async () => {
  const t = await setup();
  const rows = await t.store.collection(pf_users).query().orderBy("mainTag.name", "desc").all();
  assertEquals(rows.map((r) => r.id), ["u1", "u2", "u3"]);
});

Deno.test("REST list: filter and sort reach SQL through the HTTP route", async () => {
  const t = await setup();
  const res = await t.app.http.request(
    `/api/collections/pf_posts/records?filter=${encodeURIComponent("author.name = 'Ana'")}&sort=-views`,
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).items.map((r: { id: string }) => r.id), ["p2", "p1"]);
  const bad = await t.app.http.request(`/api/collections/pf_posts/records?filter=${encodeURIComponent("x ==")}`);
  assertEquals([bad.status, (await bad.json()).message], [400, "Something went wrong while processing your request."]);
  const forbidden = await t.app.http.request(
    `/api/collections/pf_posts/records?filter=${encodeURIComponent("@request.auth.id = ''")}`,
  );
  assertEquals(forbidden.status, 403);
});

Deno.test("parameters never reach SQL text", () => {
  const f = compilePb(pf_users, { filter: `name = "'; DROP TABLE x; --" && @request.query.a = 'b'` }, {
    collections: ALL,
    request: request({ query: { a: "'); DROP" } }),
  });
  assert(!f.where.includes("DROP"), f.where);
  assertEquals(f.params, ["'; DROP TABLE x; --", "'); DROP", "b"]);
  assertThrows(() => compilePb(pf_users, { filter: `"na""me" = 1` }, { collections: ALL }), ApiError);
});

Deno.test("equality with a non-empty text and the sort of a never-empty column reach the column's index", async () => {
  const t = await setup();
  t.db.exec(`CREATE INDEX pf_posts_author ON pf_posts (author); CREATE INDEX pf_posts_created ON pf_posts (created);
    UPDATE pf_users SET name = '' WHERE id = 'u2'`);
  // Same rows as the COALESCE form: NULL and '' match only an empty value, a number never matches text.
  assertEquals(await ids(t, "pf_posts", "author = 'u1'"), ["p1", "p2"]);
  assertEquals(await ids(t, "pf_posts", "'u2' = author"), ["p3"]);
  assertEquals(await ids(t, "pf_users", "name = 'Ana'"), ["u1"]);
  assertEquals(await ids(t, "pf_users", "name = ''"), ["u2", "u3"]);
  assertEquals(await ids(t, "pf_users", "age = 30"), ["u1"]);
  assertEquals(await ids(t, "pf_posts", "published = 'nope' || author = 'u2'"), ["p3"]);

  const plan = (filter: string, sort?: string) => {
    const f = compilePb(pf_posts, { filter: filter || undefined, sort: sort ? parsePbSort(sort) : undefined }, {
      collections: ALL,
    });
    const sql = `SELECT pf_posts.* FROM pf_posts WHERE ${f.where || "1"} ${f.orderBy} LIMIT 2`;
    return t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...f.params).map((r) => String(r.detail)).join(" | ");
  };
  assert(plan("author = 'u1'").includes("USING INDEX pf_posts_author"), plan("author = 'u1'"));
  // An empty value keeps PB's NULL-or-empty match, which no plain index answers.
  assert(!plan("author = ''").includes("pf_posts_author"), plan("author = ''"));
  assert(plan("", "-created").includes("SCAN pf_posts USING INDEX pf_posts_created"), plan("", "-created"));
  // A nullable column keeps the COALESCE in ORDER BY: NULL and '' stay one empty value, as in PB.
  assert(plan("", "title").includes("TEMP B-TREE"), plan("", "title"));
});
