import type { CollectionConfig, Req } from "../core/types.ts";
import type { Store } from "../store/mod.ts";
import { coll } from "./access.ts";

/**
 * The record engine: every read and write of every surface (REST, store, realtime, factories) goes through here.
 * read.ts and write.ts are the pipelines; access, request, present, input, hooks and files are their steps.
 */
export type { ByIdArgs, FindArgs, ListResult, QueryArgs, WriteArgs } from "./args.ts";
export { count, find, findById, query } from "./read.ts";
export { create, remove, update, updateMany } from "./write.ts";
export { validate } from "./validate.ts";
export { overrideDeps } from "./deps.ts";

/** Builds a Req over the app's store; isSuperuser derived from user.collection === "_superusers". */
export function makeReq(store: Store, user: Req["user"] = null): Req {
  return { db: store.db, store, user, isSuperuser: user?.collection === "_superusers", context: {} };
}

/** Registered collection by slug (404 ApiError when unknown). */
export function collectionBySlug(slug: string): CollectionConfig {
  return coll(slug);
}
