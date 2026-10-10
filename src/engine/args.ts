import type { Doc, Req, Where } from "../core/types.ts";
import type { RequestInfo } from "../query/mod.ts";
import type { Query } from "../store/query.ts";

/** What engine reads and writes take and return. */

export interface FindArgs {
  collection: string;
  req: Req;
  where?: Where;
  /** Raw PB filter; compiled by the PB filter compiler and ANDed with where and access. */
  filter?: string;
  sort?: string;
  page?: number;
  perPage?: number;
  expand?: string;
  fields?: string;
  /** Skips access checks; for internal/system calls only. */
  overrideAccess?: boolean;
  /** Keeps hidden fields (passwordHash, tokenKey); auth needs them to verify credentials. */
  showHidden?: boolean;
  /** PB skipTotal: no COUNT query; totalItems and totalPages come back as -1. */
  skipTotal?: boolean;
  /** Overrides the PB request info `@request.*` reads (realtime passes its subscription's query and headers). */
  requestInfo?: Partial<Omit<RequestInfo, "auth">>;
}
export interface ListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Doc[];
}
export interface WriteArgs {
  collection: string;
  req: Req;
  data: Record<string, unknown>;
  overrideAccess?: boolean;
  /** Same as FindArgs.showHidden, for the returned doc. */
  showHidden?: boolean;
  /** PB expand/fields query params applied to the returned record, as on reads. */
  expand?: string;
  fields?: string;
}

export type ByIdArgs = Omit<FindArgs, "where" | "filter" | "sort" | "page" | "perPage" | "requestInfo"> & {
  id: string;
};

export interface QueryArgs {
  collection: string;
  req: Req;
  query?: Query;
  overrideAccess?: boolean;
  showHidden?: boolean;
  expand?: string;
}
