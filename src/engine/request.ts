import { type CollectionConfig, LOCKED, type Req } from "../core/types.ts";
import { forbidden } from "../core/errors.ts";
import { collectionId, getCollection } from "../core/registry.ts";
import { type CompiledQuery, type RequestInfo, type SortField, whereToSqlAt } from "../query/mod.ts";
import { quoteIdent } from "../schema/mod.ts";
import type { Query } from "../store/query.ts";
import { deps } from "./deps.ts";
import { SECRET_FIELDS } from "./fields.ts";
import { access, bypass } from "./access.ts";
import type { FindArgs } from "./args.ts";

/** PB request info for `@request.*` and the compiled filter/sort with the read rules of every joined collection. */

/** PB's auth record as rules see it: hidden fields unhidden except the secrets, plus its collection id/name. */
function authInfo(req: Req): RequestInfo["auth"] {
  const u = req.user;
  if (!u) return null;
  const record: Record<string, unknown> = { ...u.record, id: u.id, collectionName: u.collection };
  for (const k of SECRET_FIELDS) delete record[k];
  const c = deps.collections().find((x) => x.slug === u.collection);
  if (c) record.collectionId = collectionId(c);
  return { collection: u.collection, record };
}

const LIST_PARAMS = ["filter", "sort", "page", "perPage", "expand", "fields"] as const;

/** PB RequestInfo of a list read: GET with the list params as query, unless the caller (realtime) says otherwise. */
export function requestInfo(a: FindArgs): RequestInfo {
  const query: Record<string, unknown> = {};
  for (const k of LIST_PARAMS) if (a[k] !== undefined) query[k] = String(a[k]);
  return { context: "default", method: "GET", query, headers: {}, body: {}, ...a.requestInfo, auth: authInfo(a.req) };
}

/** PB checkForSuperuserOnlyRuleFields: only superusers may use @collection/@request in filter or sort. */
export function checkRuleFields(req: Req, info: RequestInfo, override?: boolean): void {
  if (bypass(req, override)) return;
  for (const param of ["filter", "sort"]) {
    const v = info.query[param];
    if (typeof v !== "string" || !v) continue;
    for (const field of ["@collection.", "@request."]) {
      if (v.includes(field)) throw forbidden(`Only superusers can filter by ${field}`);
    }
  }
}

/**
 * Compiles a PB filter/sort and ANDs in the read rule of every collection it joined (PB listRuleJoins), as
 * `id = '' OR id IS NULL OR (rule)` so a missing relation does not hide the row.
 */
export async function compileRead(
  req: Req,
  c: CollectionConfig,
  input: { filter?: string; sort?: SortField[] },
  request: RequestInfo | null,
  allowHidden: boolean,
): Promise<CompiledQuery | undefined> {
  if (input.filter === undefined && !input.sort?.length) return undefined;
  const all = deps.collections();
  const findCollection = (nameOrId: string) => {
    try {
      return getCollection(nameOrId, all);
    } catch {
      return undefined;
    }
  };
  const pb = deps.compilePb(c, input, { collections: all, findCollection, request, allowHidden });
  for (const [i, rj] of pb.ruleJoins.entries()) {
    const r = await access(rj.collection, "read", { req, user: req.user });
    if (r === true) continue;
    let cond = "0=1";
    if (r !== false && r !== LOCKED) {
      const f = whereToSqlAt(rj.collection, rj.alias, r, all, `__r${i}_`);
      cond = f.sql;
      pb.joins.push(...f.joins);
      pb.params.push(...f.params);
    }
    const id = `${quoteIdent(rj.alias)}."id"`;
    pb.where = `${pb.where ? `${pb.where} AND ` : ""}(${id} = '' OR ${id} IS NULL OR (${cond}))`;
  }
  return pb;
}

export const sortFields = (q: Query): SortField[] | undefined =>
  q.orderBy?.map((o) => ({ name: o.field, direction: o.direction === "desc" ? "DESC" : "ASC" }));
