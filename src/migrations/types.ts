import type { IndexConfig } from "../core/types.ts";
import type { FieldShape } from "../schema/mod.ts";
import type { ViewQuery } from "../view/types.ts";

/** Serializable snapshot of a collection; functions (hooks/access) are stripped. */
export interface CollectionSnapshot {
  slug: string;
  auth: boolean;
  fields: FieldShape[];
  indexes: IndexConfig[];
  /** View collection: its query; fields are the derived ones, kept so filters and decoding see the right types. */
  view?: ViewQuery;
}
export type Snapshot = Record<string, CollectionSnapshot>;

export type MigrationOp =
  | { op: "createCollection"; collection: CollectionSnapshot }
  | { op: "dropCollection"; slug: string }
  | { op: "addField"; slug: string; field: CollectionSnapshot["fields"][number] }
  | { op: "removeField"; slug: string; name: string }
  | { op: "alterField"; slug: string; field: CollectionSnapshot["fields"][number] }
  | { op: "addIndex"; slug: string; index: IndexConfig }
  | { op: "dropIndex"; slug: string; name: string }
  | { op: "alterView"; collection: CollectionSnapshot };

/** One file per migration under migrations/<id>.json; parents form a DAG. */
export interface Migration {
  id: string;
  parents: string[];
  ops: MigrationOp[];
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  heads: string[];
}
