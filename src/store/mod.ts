import type { DatabaseSync } from "node:sqlite";
import type { AuthUser, CollectionConfig, Doc } from "../core/types.ts";
import type { InferInput, InferRecord } from "../core/infer.ts";
import { notFound } from "../core/errors.ts";
import { ensureMathFunctions } from "../core/db.ts";
import * as engine from "../engine/mod.ts";
import { type Query, QueryBuilder } from "./query.ts";
import { type BlobStore, MemoryStorage } from "../files/storage.ts";

export * from "./query.ts";

/**
 * Persistence for one collection, typed from its config. Every write runs the full pipeline (hooks, validation,
 * unique and relation checks, realtime). The system store skips access rules and sees hidden fields, like PB's
 * app.FindRecordById/app.Save; store.as(user) applies that principal's rules like the REST API.
 */
export interface CollectionStore<R, I = Partial<R>> {
  readonly collection: CollectionConfig;
  query(): QueryBuilder<R>;
  find(q?: Query): Promise<R[]>;
  findOne(id: string): Promise<R | undefined>;
  /** Like findOne, but a missing (or hidden by access) record is a 404 ApiError. */
  get(id: string): Promise<R>;
  count(q?: Query): Promise<number>;
  create(data: I): Promise<R>;
  update(id: string, data: Partial<I>): Promise<R>;
  /**
   * Many updates in one transaction, each through the full pipeline (hooks, validation, realtime) in order, with the
   * reads batched; resolves with nothing. Under store.as(user) it runs one update per item with that user's rules.
   */
  updateMany(items: readonly { id: string; data: Partial<I> }[]): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The app's record store: created once at the root and injected (req.store, createApp, beforeServe, factories). */
export interface Store {
  readonly db: DatabaseSync;
  /** Where record files live; writes put uploads there and deletes clean them after commit. */
  readonly storage: BlobStore;
  /** Typed by the config; by slug the records are untyped Docs. */
  collection<C extends CollectionConfig>(c: C): CollectionStore<InferRecord<C>, InferInput<C>>;
  collection(slug: string): CollectionStore<Doc, Record<string, unknown>>;
  /** The same store acting as user, with its access rules (null = guest). */
  as(user: AuthUser | null): Store;
}

/** Builds the system store of db. Call it once per app, where the db is opened, and pass it down. */
export function createStore(db: DatabaseSync, storage: BlobStore = new MemoryStorage()): Store {
  // The one door every store goes through: a connection opened by hand (a test's file db, a worker's) still gets the
  // functions the filters compile to (fold for ~ and like), or the first text filter fails with "no such function".
  ensureMathFunctions(db);
  const root = {} as Store;
  return Object.assign(root, bind(root, db, storage, null, true));
}

function bind(root: Store, db: DatabaseSync, storage: BlobStore, user: AuthUser | null, system: boolean): Store {
  // A fresh req per operation: req.context is a per-operation bag hooks use to talk within one write.
  const req = () => engine.makeReq(root, user);
  const opts = { overrideAccess: system, showHidden: system };
  const collection = (c: CollectionConfig): CollectionStore<Doc, Record<string, unknown>> => {
    const slug = c.slug;
    const find = (q: Query = {}) => engine.query({ collection: slug, req: req(), query: q, ...opts });
    const count = (q: Query = {}) => engine.count({ collection: slug, req: req(), query: q, overrideAccess: system });
    const findOne = async (id: string) => (await find({ where: { id: { equals: id } }, limit: 1 }))[0];
    return {
      collection: c,
      query: () => new QueryBuilder<Doc>({ find, count }),
      find,
      findOne,
      async get(id) {
        const doc = await findOne(id);
        if (!doc) throw notFound();
        return doc;
      },
      count,
      create: (data) => engine.create({ collection: slug, req: req(), data, ...opts }),
      update: (id, data) => engine.update({ collection: slug, req: req(), id, data, ...opts }),
      updateMany: (items) => engine.updateMany({ collection: slug, req: req(), items, ...opts }),
      delete: (id) => engine.remove({ collection: slug, req: req(), id, overrideAccess: system }),
    };
  };
  return {
    db,
    storage,
    collection:
      ((c: CollectionConfig | string) => collection(typeof c === "string" ? engine.collectionBySlug(c) : c)) as Store[
        "collection"
      ],
    as: (u) => bind(root, db, storage, u, false),
  };
}
