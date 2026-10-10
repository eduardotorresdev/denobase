import { type Doc, LOCKED, type Where } from "../core/types.ts";
import { notFound } from "../core/errors.ts";
import { andWhere, parsePbSort } from "../query/mod.ts";
import * as sql from "../store/sqlite.ts";
import { access, bypass, coll, loadRaw, locked, NOTHING, readWhere } from "./access.ts";
import type { ByIdArgs, FindArgs, ListResult, QueryArgs } from "./args.ts";
import { present } from "./present.ts";
import { traced } from "../telemetry/instrument/child.ts";
import { checkRuleFields, compileRead, requestInfo, sortFields } from "./request.ts";

const MAX_PER_PAGE = 1000;

/** Lists with access where ANDed, afterRead hooks and field read access applied. */
export function find(a: FindArgs): Promise<ListResult> {
  return traced(`record.list ${a.collection}`, { attributes: { "denobase.collection": a.collection } }, () => list(a));
}

async function list(a: FindArgs): Promise<ListResult> {
  const c = coll(a.collection);
  let accessWhere: Where | undefined;
  if (!bypass(a.req, a.overrideAccess)) {
    const r = await access(c, "read", { req: a.req, user: a.req.user });
    // PB: a nil ListRule is 403; a rule that matches nothing is just an empty page.
    if (r === LOCKED) throw locked();
    if (r === false) accessWhere = NOTHING;
    else if (r !== true) accessWhere = r;
  }
  const info = requestInfo(a);
  checkRuleFields(a.req, info, a.overrideAccess);
  // PB's realtime filter resolver never allows hidden fields, not even for superusers.
  const allowHidden = bypass(a.req, a.overrideAccess) && info.context !== "realtime";
  const sort = a.sort ? parsePbSort(a.sort) : undefined;
  const pb = await compileRead(a.req, c, { filter: a.filter || undefined, sort }, info, allowHidden);
  const where = andWhere(a.where, accessWhere);
  const perPage = Math.min(Math.max(1, Math.trunc(a.perPage ?? 30)), MAX_PER_PAGE);
  const page = Math.max(1, Math.trunc(a.page ?? 1));
  const totalItems = a.skipTotal ? -1 : sql.count(a.req.db, c, where, pb);
  const raws = sql.findMany(a.req.db, c, { where, limit: perPage, offset: (page - 1) * perPage }, pb);
  const opts = {
    override: a.overrideAccess,
    showHidden: a.showHidden,
    expand: a.expand,
    fields: a.fields,
    memo: new Map(),
  };
  const items: Doc[] = [];
  for (const raw of raws) items.push(await present(a.req, c, raw, opts));
  const totalPages = a.skipTotal ? -1 : Math.ceil(totalItems / perPage);
  return { page, perPage, totalItems, totalPages, items };
}

/** The store's read: an abstract Query (no PB paging), access ANDed unless overridden, full read pipeline. */
export async function query(a: QueryArgs): Promise<Doc[]> {
  const c = coll(a.collection);
  const q = a.query ?? {};
  const where = andWhere(q.where, await readWhere(a.req, c, a.overrideAccess));
  // Sorting goes through the PB compiler so relation paths join like PB sort does.
  const pb = await compileRead(a.req, c, { sort: sortFields(q) }, null, bypass(a.req, a.overrideAccess));
  const raws = sql.findMany(a.req.db, c, { ...q, where }, pb);
  const opts = { override: a.overrideAccess, showHidden: a.showHidden, expand: a.expand, memo: new Map() };
  const out: Doc[] = [];
  for (const raw of raws) out.push(await present(a.req, c, raw, opts));
  return out;
}

export async function count(a: Omit<QueryArgs, "expand" | "showHidden">): Promise<number> {
  const c = coll(a.collection);
  return sql.count(a.req.db, c, andWhere(a.query?.where, await readWhere(a.req, c, a.overrideAccess)));
}

/** 404 when missing or filtered out by access (PB hides existence). */
export function findById(a: ByIdArgs): Promise<Doc> {
  return traced(`record.view ${a.collection}`, {
    attributes: { "denobase.collection": a.collection, "denobase.record.id": a.id },
  }, () => view(a));
}

async function view(a: ByIdArgs): Promise<Doc> {
  const c = coll(a.collection);
  let where: Where = {};
  if (!bypass(a.req, a.overrideAccess)) {
    const r = await access(c, "read", { req: a.req, user: a.req.user, id: a.id });
    if (r === LOCKED) throw locked();
    if (r === false) throw notFound();
    if (r !== true) where = r;
  }
  const raw = loadRaw(a.req, c, a.id, where);
  if (!raw) throw notFound();
  return present(a.req, c, raw, {
    override: a.overrideAccess,
    showHidden: a.showHidden,
    expand: a.expand,
    fields: a.fields,
  });
}
