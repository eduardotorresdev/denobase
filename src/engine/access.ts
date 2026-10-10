import { type AccessArgs, type CollectionConfig, type Doc, LOCKED, type Req, type Where } from "../core/types.ts";
import { badRequest, forbidden, notFound } from "../core/errors.ts";
import { getCollection } from "../core/registry.ts";
import * as sql from "../store/sqlite.ts";
import { deps } from "./deps.ts";

/** Collection rules (PB list/view/create/update/delete/manage rules as fns) and rule-guarded row loads. */

export function coll(slug: string): CollectionConfig {
  return getCollection(slug, deps.collections());
}
export const bypass = (req: Req, override?: boolean) => !!override || req.isSuperuser;

/** PB manageRule: bypass, or the auth config's manage fn returning true; missing fn means superuser-only. */
export async function canManage(c: CollectionConfig, args: AccessArgs, override?: boolean): Promise<boolean> {
  if (bypass(args.req, override)) return true;
  const fn = typeof c.auth === "object" ? c.auth.manage : undefined;
  return !!fn && (await fn(args)) === true;
}

/** PB's 403 for a nil rule hit by a non-superuser. */
export const locked = () => forbidden("Only superusers can perform this action.");

/**
 * Resolves collection access: true = all, Where = restricted, false = a rule that matched nothing, LOCKED = PB nil
 * rule (superusers only). A missing fn, the LOCKED sentinel or a fn returning LOCKED is LOCKED.
 */
export async function access(
  c: CollectionConfig,
  op: keyof NonNullable<CollectionConfig["access"]>,
  args: AccessArgs,
): Promise<boolean | Where | typeof LOCKED> {
  const fn = c.access?.[op];
  if (!fn || fn === LOCKED) return LOCKED;
  const r = await fn(args);
  if (r === true || r === false || r === LOCKED) return r;
  return r && typeof r === "object" ? r : false;
}

export function loadRaw(req: Req, c: CollectionConfig, id: string, where: Where = {}): Doc | null {
  return sql.findOne(req.db, c, id, where);
}

/** PB answers any write to a view collection with this 400, before access or validation. */
export function writable(c: CollectionConfig): void {
  if (c.view) throw badRequest("Unsupported collection type.");
}

/** Matches no row: a rule that evaluated false, ANDed in like PB's filter. */
export const NOTHING: Where = { id: { equals: "" } };

/** Read access as a Where to AND in (undefined = all); 403 when locked, NOTHING when the rule rejects, like find. */
export async function readWhere(req: Req, c: CollectionConfig, override?: boolean): Promise<Where | undefined> {
  if (bypass(req, override)) return undefined;
  const r = await access(c, "read", { req, user: req.user });
  if (r === LOCKED) throw locked();
  if (r === false) return NOTHING;
  return r === true ? undefined : r;
}

/** Loads the target honoring a Where access result; 403 only when locked, else 404 hides rows, like PB. */
export async function guarded(
  req: Req,
  c: CollectionConfig,
  op: "update" | "delete",
  id: string,
  override: boolean | undefined,
  data?: Record<string, unknown>,
): Promise<Doc> {
  let where: Where = {};
  if (!bypass(req, override)) {
    const r = await access(c, op, { req, user: req.user, id, data });
    if (r === LOCKED) throw locked();
    if (r === false) throw notFound();
    if (r !== true) where = r;
  }
  const doc = loadRaw(req, c, id, where);
  if (!doc) throw notFound();
  return doc;
}
