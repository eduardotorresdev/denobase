import { type ChangedItem, type CollectionConfig, type Doc, LOCKED, type Req } from "../core/types.ts";
import { badRequest, notFound } from "../core/errors.ts";
import { afterCommit, tx } from "../core/db.ts";
import * as sql from "../store/sqlite.ts";
import { allFields } from "./fields.ts";
import { validate } from "./validate.ts";
import { authInput } from "./auth.ts";
import { notifyChanged, notifyDeleting } from "./events.ts";
import { type FileChanges, fileNames, prepareFiles, recordDir } from "./files.ts";
import { applyModifiers } from "./modifiers.ts";
import { access, bypass, canManage, coll, guarded, loadRaw, locked, writable } from "./access.ts";
import type { WriteArgs } from "./args.ts";
import { runCollHooks, runFieldHooks, traceHook } from "./hooks.ts";
import { traced } from "../telemetry/instrument/child.ts";
import { checkDb, forgetFoundRelations, known, recordId, withDefaults } from "./input.ts";
import { present } from "./present.ts";

/** `record.<op> <collection>` span around a write pipeline. */
function traceRecord<T>(op: string, collection: string, id: string | undefined, fn: () => Promise<T>): Promise<T> {
  return traced(`record.${op} ${collection}`, {
    attributes: { "denobase.collection": collection, "denobase.record.id": id },
  }, fn);
}

/** Runs beforeValidate -> validate -> beforeChange -> insert -> afterChange inside one tx. */
export function create(a: WriteArgs): Promise<Doc> {
  return traceRecord("create", a.collection, undefined, () => createRecord(a));
}

async function createRecord(a: WriteArgs): Promise<Doc> {
  const c = coll(a.collection);
  writable(c);
  const req = a.req;
  return await tx(req.db, async () => {
    const manage = !!c.auth && await canManage(c, { req, user: req.user, data: a.data }, a.overrideAccess);
    const input = applyModifiers(c, await authInput(c, a.data, "create", !!a.overrideAccess, undefined, manage));
    let data = withDefaults(c, known(c, input));
    if (!bypass(req, a.overrideAccess)) {
      // A Where makes no sense for a row that does not exist yet, so only true allows.
      const r = await access(c, "create", { req, user: req.user, data });
      if (r === LOCKED) throw locked();
      // PB answers a create rule that evaluates false with this 400, never 403.
      if (r !== true) throw badRequest("Failed to create record.");
    }
    await runFieldHooks(req, c, "beforeValidate", data, "create");
    data = known(c, await runCollHooks(req, c, "beforeValidate", data, "create"));
    const id = recordId(req, c, a.data.id, a.overrideAccess);
    const errs = {};
    const files = prepareFiles(c, data, undefined, errs);
    validate(c, data, "create", errs);
    checkDb(req, c, data, "create", id);
    await runFieldHooks(req, c, "beforeChange", data, "create");
    data = known(c, await runCollHooks(req, c, "beforeChange", data, "create"));
    sql.insert(req.db, c, id, data);
    await storeFiles(req, c, id, files);
    let doc = loadRaw(req, c, id)!;
    const after = c.hooks?.afterChange ?? [];
    doc = await traceHook(c, "afterChange", after.length, async () => {
      for (const h of after) doc = (await h({ req, collection: c, operation: "create", data, doc })) ?? doc;
      return doc;
    });
    await afterChangeMany(req, c, "create", [{ data, doc }]);
    notifyChanged({ db: req.db, collection: c, id, action: "create" });
    return present(req, c, doc, {
      override: a.overrideAccess,
      showHidden: a.showHidden,
      expand: a.expand,
      fields: a.fields,
    });
  });
}

/** PATCH semantics: only sent keys change; validation runs on the merged record. */
export function update(a: WriteArgs & { id: string }): Promise<Doc> {
  return traceRecord("update", a.collection, a.id, () => updateRecord(a));
}

async function updateRecord(a: WriteArgs & { id: string }): Promise<Doc> {
  const c = coll(a.collection);
  writable(c);
  const req = a.req;
  return await tx(req.db, async () => {
    const original = await guarded(req, c, "update", a.id, a.overrideAccess, known(c, a.data));
    const doc = await applyUpdate(c, req, a, original);
    return present(req, c, doc, {
      override: a.overrideAccess,
      showHidden: a.showHidden,
      expand: a.expand,
      fields: a.fields,
    });
  });
}

/** The update pipeline from the read original on: hooks, validation, the write, afterChange and realtime. */
async function applyUpdate(c: CollectionConfig, req: Req, a: WriteArgs & { id: string }, original: Doc): Promise<Doc> {
  let data = known(c, a.data);
  const manage = !!c.auth && await canManage(c, { req, user: req.user, id: a.id, data }, a.overrideAccess);
  const input = await authInput(c, { ...a.data, ...data }, "update", !!a.overrideAccess, original, manage);
  data = known(c, applyModifiers(c, input, original));
  if (!bypass(req, a.overrideAccess)) {
    for (const f of allFields(c)) {
      if (!(f.name in data) || !f.access?.update) continue;
      // Payload drops fields the caller may not update instead of failing the whole write.
      if (!(await f.access.update({ req, user: req.user, id: a.id, data, doc: original }))) delete data[f.name];
    }
  }
  await runFieldHooks(req, c, "beforeValidate", data, "update", original);
  data = known(c, await runCollHooks(req, c, "beforeValidate", data, "update", original));
  const errs = {};
  const files = prepareFiles(c, data, original, errs);
  validate(c, { ...original, ...data }, "update", errs);
  checkDb(req, c, data, "update", a.id);
  await runFieldHooks(req, c, "beforeChange", data, "update", original);
  data = known(c, await runCollHooks(req, c, "beforeChange", data, "update", original));
  sql.update(req.db, c, a.id, data);
  await storeFiles(req, c, a.id, files);
  let doc = loadRaw(req, c, a.id)!;
  const after = c.hooks?.afterChange ?? [];
  doc = await traceHook(c, "afterChange", after.length, async () => {
    for (const h of after) {
      doc = (await h({ req, collection: c, operation: "update", data, originalDoc: original, doc })) ?? doc;
    }
    return doc;
  });
  await afterChangeMany(req, c, "update", [{ data, originalDoc: original, doc }]);
  notifyChanged({ db: req.db, collection: c, id: a.id, action: "update" });
  return doc;
}

/** The collection's afterChangeMany hooks over the records one write call wrote. */
async function afterChangeMany(
  req: Req,
  c: CollectionConfig,
  operation: "create" | "update",
  items: readonly ChangedItem[],
): Promise<void> {
  const hooks = c.hooks?.afterChangeMany ?? [];
  if (!hooks.length || !items.length) return;
  await traceHook(c, "afterChangeMany", hooks.length, async () => {
    for (const h of hooks) await h({ req, collection: c, operation, items });
  });
}

/**
 * Whether updateMany may write the rows in one statement: nothing has to run per row around the write (no before
 * hooks, no afterChange, no field hooks, no auth or file handling) and no id repeats (a repeat chains on the previous
 * write). What runs after the write is afterChangeMany, once, with every record.
 */
function emConjunto(c: CollectionConfig, items: readonly { id: string; data: Record<string, unknown> }[]): boolean {
  const h = c.hooks ?? {};
  if (c.auth || h.beforeValidate?.length || h.beforeChange?.length || h.afterChange?.length) return false;
  for (const f of allFields(c)) {
    if (f.hooks?.beforeValidate?.length || f.hooks?.beforeChange?.length) return false;
    if (f.type === "file" && items.some((it) => f.name in it.data)) return false;
  }
  return new Set(items.map((it) => it.id)).size === items.length;
}

/**
 * The set path of updateMany: each item is checked in memory exactly as update checks it (modifiers, validation on
 * the merged record, unique and relation checks), then every row is written by one statement and afterChangeMany
 * runs once with all of them. Any item failing fails the whole call before anything is written.
 */
async function updateEmConjunto(
  c: CollectionConfig,
  req: Req,
  items: readonly { id: string; data: Record<string, unknown> }[],
  originals: Map<string, Doc>,
): Promise<void> {
  const prontos: { id: string; data: Record<string, unknown>; original: Doc }[] = [];
  for (const it of items) {
    const original = originals.get(it.id);
    if (!original) throw notFound();
    const data = known(c, applyModifiers(c, known(c, it.data), original));
    const errs = {};
    validate(c, { ...original, ...data }, "update", errs);
    checkDb(req, c, data, "update", it.id);
    prontos.push({ id: it.id, data, original });
  }
  const docs = sql.updateMany(req.db, c, prontos);
  const changed: ChangedItem[] = prontos.map((p) => ({ data: p.data, originalDoc: p.original, doc: docs.get(p.id)! }));
  await afterChangeMany(req, c, "update", changed);
  for (const p of prontos) notifyChanged({ db: req.db, collection: c, id: p.id, action: "update" });
}

/** Ids per read below SQLite's variable cap. */
const ORIGINALS_PER_READ = 500;

/**
 * Many updates in one transaction, each through the full pipeline in order. On the system store the originals are
 * read in one statement per slice instead of one per item, and nothing is presented back; under a user's rules each
 * item is a plain update. A hook of the batch that writes another row of the same batch leaves that row's original
 * as read at the start.
 */
export function updateMany(
  a: Omit<WriteArgs, "data"> & { items: readonly { id: string; data: Record<string, unknown> }[] },
): Promise<void> {
  return traced(`record.updateMany ${a.collection}`, {
    attributes: { "denobase.collection": a.collection, "denobase.record.count": a.items.length },
  }, async () => {
    const c = coll(a.collection);
    writable(c);
    const req = a.req;
    await tx(req.db, async () => {
      if (!bypass(req, a.overrideAccess)) {
        for (const it of a.items) await updateRecord({ ...a, id: it.id, data: it.data });
        return;
      }
      const ids = [...new Set(a.items.map((it) => it.id))];
      const originals = new Map<string, Doc>();
      for (let i = 0; i < ids.length; i += ORIGINALS_PER_READ) {
        const where = { id: { in: ids.slice(i, i + ORIGINALS_PER_READ) } };
        for (const d of sql.findMany(req.db, c, { where })) originals.set(d.id, d);
      }
      if (emConjunto(c, a.items)) return await updateEmConjunto(c, req, a.items, originals);
      for (const it of a.items) {
        const original = originals.get(it.id);
        if (!original) throw notFound();
        // A later item for the same id starts from this one's write.
        originals.set(it.id, await applyUpdate(c, req, { ...a, id: it.id, data: it.data }, original));
      }
    });
  });
}

export function remove(a: Omit<WriteArgs, "data"> & { id: string }): Promise<void> {
  return traceRecord("delete", a.collection, a.id, () => removeRecord(a));
}

async function removeRecord(a: Omit<WriteArgs, "data"> & { id: string }): Promise<void> {
  const c = coll(a.collection);
  writable(c);
  const req = a.req;
  return await tx(req.db, async () => {
    const doc = await guarded(req, c, "delete", a.id, a.overrideAccess);
    const before = c.hooks?.beforeDelete ?? [];
    await traceHook(c, "beforeDelete", before.length, async () => {
      for (const h of before) await h({ req, collection: c, id: a.id });
    });
    await notifyDeleting({ db: req.db, collection: c, id: a.id, action: "delete" });
    sql.remove(req.db, c, a.id);
    forgetFoundRelations(req);
    // PB deletes a record's files only once the delete is committed.
    if (fileNames(c, doc).length) {
      const dir = recordDir(c, a.id);
      afterCommit(req.db, () => void req.store.storage.deletePrefix(dir).catch((e) => logFileDeleteError(dir, e)));
    }
    const after = c.hooks?.afterDelete ?? [];
    await traceHook(c, "afterDelete", after.length, async () => {
      for (const h of after) await h({ req, collection: c, id: a.id, doc });
    });
  });
}

/**
 * After commit the record is gone and nobody awaits the cleanup: a storage failure (S3 down, 5xx) must only be
 * logged, as PB does, since an unhandled rejection would end the process.
 */
function logFileDeleteError(key: string, e: unknown): void {
  console.error("Failed to delete files", key, e);
}

/** Uploads inside the write's tx (a failed upload rolls the row back); dropped files go only after commit. */
async function storeFiles(req: Req, c: CollectionConfig, id: string, files: FileChanges): Promise<void> {
  const { storage } = req.store;
  const dir = recordDir(c, id);
  for (const u of files.uploads) {
    await storage.put(dir + u.name, u.file.stream(), { type: u.file.type });
  }
  if (files.removed.length) {
    afterCommit(req.db, () => {
      for (const n of files.removed) void storage.delete(dir + n).catch((e) => logFileDeleteError(dir + n, e));
    });
  }
}
