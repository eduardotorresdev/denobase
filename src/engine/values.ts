import type { Field } from "../core/types.ts";
import { isMany } from "../schema/mod.ts";

/** A field value seen as a list and back, the shape PB's multi-value setters work on. */

/** A file field item: an upload (File) or a name already stored. */
export type FileItem = File | string;

/** File values: uploads and names, flattened; "" and null are no file. */
export function fileList(v: unknown): FileItem[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.flatMap(fileList);
  if (v instanceof File) return [v];
  return [String(v)];
}

export function asList(f: Field, v: unknown): unknown[] {
  if (f.type === "file") return fileList(v);
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/** Single-value fields keep the last item, like PB's normalizeValue. */
export function fromList(f: Field, list: unknown[]): unknown {
  if (isMany(f)) return list;
  return list.length ? list[list.length - 1] : "";
}
