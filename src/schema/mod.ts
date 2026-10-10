import type { CollectionConfig, Field } from "../core/types.ts";

/** Column as stored; hasMany relationship/select are JSON text columns, like PB. */
export interface ColumnDef {
  name: string;
  sqlType: "TEXT" | "REAL" | "INTEGER";
  notNull: boolean;
  unique: boolean;
  /** For single relationship: referenced table. */
  references?: string;
}
export interface TableDef {
  name: string;
  columns: ColumnDef[];
  indexes: { name: string; columns: string[]; unique: boolean; desc?: string[]; where?: string }[];
}

/** Minimal field shape the schema needs; lets migrations pass snapshot fields without hooks/access. */
export type FieldShape = Field extends infer F ? F extends Field ? Omit<F, "hooks" | "access" | "schema"> : never
  : never;
/** Minimal collection shape; config and snapshot both satisfy it. */
export interface CollectionShape {
  slug: string;
  auth?: unknown;
  fields: FieldShape[];
  indexes?: { name?: string; fields: string[]; unique?: boolean; desc?: string[]; where?: string }[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Table name for a collection slug (identity, validated against [a-z_][a-z0-9_]*). */
export function tableName(slug: string): string {
  if (!IDENT.test(slug)) throw new Error(`invalid collection slug: ${slug}`);
  return slug;
}

/** Multi-value fields: hasMany select/relationship and file with maxSelect > 1 (PB stores them as JSON lists). */
export const isMany = (f: FieldShape) =>
  ((f.type === "relationship" || f.type === "select") && !!f.hasMany) || (f.type === "file" && (f.maxSelect ?? 1) > 1);

/** Maps one field to its column; null for virtual fields. */
export function fieldToColumn(field: FieldShape): ColumnDef | null {
  if (field.virtual) return null;
  const sqlType = field.type === "checkbox"
    ? "INTEGER"
    : field.type === "number"
    ? (field.integer ? "INTEGER" : "REAL")
    : "TEXT";
  // Required is enforced by the engine: NOT NULL would force a DEFAULT on ADD COLUMN, i.e. a data decision.
  const col: ColumnDef = { name: field.name, sqlType, notNull: false, unique: !!field.unique };
  if (field.type === "relationship" && !field.hasMany) col.references = tableName(field.relationTo);
  return col;
}

const AUTH_COLUMNS: ColumnDef[] = [
  { name: "email", sqlType: "TEXT", notNull: true, unique: true },
  { name: "passwordHash", sqlType: "TEXT", notNull: true, unique: false },
  { name: "tokenKey", sqlType: "TEXT", notNull: true, unique: false },
  { name: "emailVisibility", sqlType: "INTEGER", notNull: true, unique: false },
  { name: "verified", sqlType: "INTEGER", notNull: true, unique: false },
];

/** Implicit auth columns; migrate up adds any an older database lacks (they are not in snapshots). */
export function authColumns(): ColumnDef[] {
  return AUTH_COLUMNS.map((c) => ({ ...c }));
}

/** Default index name; slug-prefixed because SQLite index names are global per database. */
export function indexName(slug: string, fields: string[], name?: string): string {
  return name ?? `idx_${slug}_${fields.join("_")}`;
}

/** Full table incl. implicit id/created/updated and auth columns (email, passwordHash, tokenKey, verified). */
export function collectionToTable(c: CollectionConfig | CollectionShape): TableDef {
  const name = tableName(c.slug);
  const columns: ColumnDef[] = [
    { name: "id", sqlType: "TEXT", notNull: true, unique: false },
    { name: "created", sqlType: "TEXT", notNull: true, unique: false },
    { name: "updated", sqlType: "TEXT", notNull: true, unique: false },
  ];
  const own = new Set(c.fields.map((f) => f.name));
  if (c.auth) columns.push(...AUTH_COLUMNS.filter((a) => !own.has(a.name)));
  for (const f of c.fields) {
    const col = fieldToColumn(f);
    if (col) columns.push(col);
  }
  // Unique as index, not column constraint: ALTER TABLE ADD COLUMN cannot add UNIQUE.
  const indexes = columns.filter((x) => x.unique).map((x) => ({
    name: indexName(c.slug, [x.name]),
    columns: [x.name],
    unique: true,
  }));
  for (const i of c.indexes ?? []) {
    indexes.push({
      name: indexName(c.slug, i.fields, i.name),
      columns: i.fields,
      unique: !!i.unique,
      ...(i.desc?.length ? { desc: i.desc } : {}),
      ...(i.where ? { where: i.where } : {}),
    });
  }
  return { name, columns, indexes };
}

/** DDL for one column, as used by CREATE TABLE and ADD COLUMN. */
export function columnSql(col: ColumnDef): string {
  let s = `${quoteIdent(col.name)} ${col.sqlType}`;
  if (col.name === "id") return `${s} PRIMARY KEY NOT NULL`;
  if (col.notNull) s += col.sqlType === "INTEGER" ? " NOT NULL DEFAULT 0" : " NOT NULL DEFAULT ''";
  if (col.references) s += ` REFERENCES ${quoteIdent(col.references)}(${quoteIdent("id")})`;
  return s;
}

export function createTableSql(t: TableDef, name = t.name): string {
  return `CREATE TABLE ${quoteIdent(name)} (${t.columns.map(columnSql).join(", ")})`;
}

export function createIndexSql(table: string, i: TableDef["indexes"][number]): string {
  const cols = i.columns.map((c) => quoteIdent(c) + (i.desc?.includes(c) ? " DESC" : "")).join(", ");
  const where = i.where ? ` WHERE ${i.where}` : "";
  return `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(i.name)} ON ${quoteIdent(table)} (${cols})${where}`;
}

/** Encodes a JS value to its SQLite storage form (json stringify, bool->0/1). */
export function toDb(field: Field | FieldShape, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  // PB's empty single relation is "": stored as NULL so the column's foreign key holds.
  if (field.type === "relationship" && !isMany(field) && value === "") return null;
  if (field.type === "checkbox") return value ? 1 : 0;
  if (field.type === "json" || isMany(field)) return JSON.stringify(value);
  if (field.type === "number") return Number(value);
  return value;
}

/** Decodes a stored value back to JS, with PB zero values for NULL so clients never see null scalars. */
export function fromDb(field: Field | FieldShape, value: unknown): unknown {
  return decoderFor(field)(value);
}

const decodeMany = (v: unknown): unknown => v == null || v === "" ? [] : JSON.parse(String(v));
const decodeCheckbox = (v: unknown): unknown => !!v;
const decodeJson = (v: unknown): unknown => v == null || v === "" ? null : JSON.parse(String(v));
const decodeNumber = (v: unknown): unknown => v == null ? 0 : Number(v);
const decodeScalar = (v: unknown): unknown => v == null ? "" : v;

/** fromDb resolved once per field: the store compiles a row decoder from these instead of switching per value. */
export function decoderFor(field: Field | FieldShape): (value: unknown) => unknown {
  if (isMany(field)) return decodeMany;
  switch (field.type) {
    case "checkbox":
      return decodeCheckbox;
    case "json":
      return decodeJson;
    case "number":
      return decodeNumber;
    default:
      return decodeScalar;
  }
}

/** Quotes an identifier; the only way identifiers enter SQL. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
