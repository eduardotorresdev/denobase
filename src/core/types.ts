import type { DatabaseSync } from "node:sqlite";
import type { ZodType } from "zod";
import type { ViewQuery } from "../view/types.ts";
import type { Store } from "../store/mod.ts";

/** Payload-style where; operators map 1:1 to Payload so access fns read the same as in Payload docs. */
export type WhereOp = {
  equals?: unknown;
  not_equals?: unknown;
  in?: unknown[];
  not_in?: unknown[];
  like?: string;
  exists?: boolean;
  greater_than?: unknown;
  less_than?: unknown;
  /** Additive: PB filters need >=, <= and !~, which Payload also names this way. */
  greater_than_equal?: unknown;
  less_than_equal?: unknown;
  not_like?: string;
};
export type Where = { and?: Where[]; or?: Where[] } & { [path: string]: WhereOp | Where[] | undefined };

export type Doc = Record<string, unknown> & { id: string; created?: string; updated?: string };

/** Authenticated principal; collection tells superuser from users. */
export interface AuthUser {
  id: string;
  collection: string;
  record: Doc;
}

/** Per-request context passed to access fns and hooks; db is the active (possibly tx) handle. */
export interface Req {
  db: DatabaseSync;
  /** The app's one system store (injected at the root), for hooks and access fns that read or write records. */
  store: Store;
  user: AuthUser | null;
  isSuperuser: boolean;
  /** Free-form bag for hooks to pass data within one operation. */
  context: Record<string, unknown>;
}

export interface AccessArgs {
  req: Req;
  user: AuthUser | null;
  data?: Record<string, unknown>;
  id?: string;
}
/** LOCKED from a fn is a PB nil rule for this call, e.g. `({ id }) => id ? LOCKED : true` for "list open, view nil". */
export type AccessResult = boolean | Where | typeof LOCKED;
export type AccessFn = (args: AccessArgs) => AccessResult | Promise<AccessResult>;
/**
 * A PB nil rule: superusers only, non-superusers get 403. Same as leaving the op out of `access`; a fn returning
 * false is instead a PB rule that matched nothing (list 200 empty, view/update/delete 404, create 400).
 */
export const LOCKED: unique symbol = Symbol("denobase.access.locked");
export type CollectionAccess = AccessFn | typeof LOCKED;

export interface FieldAccess {
  read?: (args: AccessArgs & { doc?: Doc }) => boolean | Promise<boolean>;
  update?: (args: AccessArgs & { doc?: Doc }) => boolean | Promise<boolean>;
}

export interface FieldHookArgs {
  req: Req;
  value: unknown;
  data: Record<string, unknown>;
  originalDoc?: Doc;
  operation: Operation;
}
export type FieldHook = (args: FieldHookArgs) => unknown | Promise<unknown>;
export interface FieldHooks {
  beforeValidate?: FieldHook[];
  beforeChange?: FieldHook[];
  afterRead?: FieldHook[];
}

interface BaseField {
  name: string;
  required?: boolean;
  unique?: boolean;
  /** Virtual fields are computed in hooks and never stored. */
  virtual?: boolean;
  /** Hidden fields never leave the server (password hash, tokenKey). */
  hidden?: boolean;
  defaultValue?: unknown;
  access?: FieldAccess;
  hooks?: FieldHooks;
  /**
   * Zod schema run after the type check, on the value the type check accepted. On a json field it also types
   * the value (z.infer). An issue may carry params.code to answer with that PB error code.
   */
  schema?: ZodType;
}
export type Field =
  | (BaseField & { type: "text"; minLength?: number; maxLength?: number })
  | (BaseField & { type: "email" })
  | (BaseField & { type: "number"; min?: number; max?: number; integer?: boolean })
  | (BaseField & { type: "checkbox" })
  | (BaseField & { type: "date" })
  | (BaseField & { type: "json" })
  | (BaseField & { type: "select"; options: string[]; hasMany?: boolean })
  | (BaseField & { type: "relationship"; relationTo: string; hasMany?: boolean })
  | (BaseField & {
    type: "file";
    /** More than 1 stores a list of names; PB's default is a single file. */
    maxSelect?: number;
    /** Bytes per file; PB's default is 5MB. */
    maxSize?: number;
    mimeTypes?: string[];
    /** Extra thumb sizes ("WxH") clients may ask for, besides PB's 100x100. */
    thumbs?: string[];
    /** Downloads need a file token and pass the collection's read access. */
    protected?: boolean;
  });
export type FieldType = Field["type"];

export type Operation = "create" | "update" | "read" | "delete";

export interface HookArgs {
  req: Req;
  collection: CollectionConfig;
  operation: Operation;
  data: Record<string, unknown>;
  originalDoc?: Doc;
}
/** One record an afterChangeMany hook sees: what was sent, the record before (absent on create) and after. */
export interface ChangedItem {
  data: Record<string, unknown>;
  originalDoc?: Doc;
  doc: Doc;
}

export interface ChangeManyArgs {
  req: Req;
  collection: CollectionConfig;
  operation: "create" | "update";
  items: readonly ChangedItem[];
}

export type Hooks = {
  beforeValidate?: ((a: HookArgs) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>)[];
  beforeChange?: ((a: HookArgs) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>)[];
  afterChange?: ((a: HookArgs & { doc: Doc }) => Doc | void | Promise<Doc | void>)[];
  /**
   * After every create or update, once per write call with the records it wrote: one item for create and update, all
   * of them for updateMany. It cannot replace the records. A collection whose only after-write work is here (no
   * afterChange, no before hooks) lets updateMany write its rows in one statement.
   */
  afterChangeMany?: ((a: ChangeManyArgs) => void | Promise<void>)[];
  beforeRead?: ((a: { req: Req; collection: CollectionConfig; doc: Doc }) => Doc | void | Promise<Doc | void>)[];
  afterRead?: ((a: { req: Req; collection: CollectionConfig; doc: Doc }) => Doc | void | Promise<Doc | void>)[];
  beforeDelete?: ((a: { req: Req; collection: CollectionConfig; id: string }) => void | Promise<void>)[];
  afterDelete?: ((a: { req: Req; collection: CollectionConfig; id: string; doc: Doc }) => void | Promise<void>)[];
};

export interface IndexConfig {
  name?: string;
  fields: string[];
  unique?: boolean;
  /** Fields (of `fields`) indexed DESC, so a mixed ORDER BY (e.g. -a,b) is served by the index. */
  desc?: string[];
  /** Partial index predicate (raw SQLite, over the collection's own columns), e.g. "encerrada_em = ''". */
  where?: string;
}

export interface AuthConfig {
  /** Seconds; PB default 7 days is mirrored. */
  tokenExpiration?: number;
  otp?: { enabled: boolean; duration?: number; length?: number };
  /** PB authAlert: mail the record when it logs in from a new origin (ip + user agent). */
  authAlert?: { enabled: boolean };
  /** PB manageRule: who may set email/verified directly and change a password without oldPassword. */
  manage?: AccessFn;
}

export interface CollectionConfig {
  slug: string;
  /** Auth collections get email, password hash, tokenKey and verified columns implicitly. */
  auth?: boolean | AuthConfig;
  fields: Field[];
  access?: { read?: CollectionAccess; create?: CollectionAccess; update?: CollectionAccess; delete?: CollectionAccess };
  hooks?: Hooks;
  indexes?: IndexConfig[];
  /** Zod schema over the whole candidate record (after field checks), for rules spanning fields. */
  schema?: ZodType;
  /** View collection: rows come from this query (a SQL VIEW); fields are derived from it and writes refused. */
  view?: ViewQuery;
  /**
   * PB's id field when it is not the default 15 chars of [a-z0-9]: a client-chosen id must match it. With `generate`
   * a blank id is made by it (PB's autogeneratePattern); without `generate` or `autogenerate` the id is required on
   * create (PB's empty autogeneratePattern).
   */
  id?: IdConfig;
}

export interface IdConfig {
  min: number;
  max: number;
  pattern: RegExp;
  /** A blank id gets the default 15-char id. */
  autogenerate?: boolean;
  /** A blank id gets a fresh one from here, retried while it collides with an existing row. */
  generate?: () => string;
}
