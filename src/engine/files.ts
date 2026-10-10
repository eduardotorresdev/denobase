import type { CollectionConfig, Doc, Field } from "../core/types.ts";
import type { ApiError } from "../core/errors.ts";
import { collectionId } from "../core/registry.ts";
import { isMany } from "../schema/mod.ts";
import { normalizeName } from "../files/name.ts";
import { allFields } from "./fields.ts";
import { fileList, fromList } from "./values.ts";

/** PB file-field validation: what a write may put in a file field, and the uploads it brings. */

export type FileField = Extract<Field, { type: "file" }>;
export const DEFAULT_MAX_SIZE = 5 << 20;

const maxSelect = (f: FileField) => Math.max(1, f.maxSelect ?? 1);

/** "<collectionId>/<recordId>/" in storage, PB's record.BaseFilesPath(). */
export const recordDir = (c: CollectionConfig, id: string) => `${collectionId(c)}/${id}/`;

export interface Upload {
  name: string;
  file: File;
}

export interface FileChanges {
  uploads: Upload[];
  /** Stored names the write drops; deleted from storage after commit. */
  removed: string[];
}

type Errs = ApiError["data"];

/**
 * PB FileField.ValidateValue plus the upload naming: new names must come as uploads (a client cannot point a record
 * at a file it did not upload), then count, size and type. Uploads are replaced in data by their stored names.
 */
export function prepareFiles(
  c: CollectionConfig,
  data: Record<string, unknown>,
  original: Doc | undefined,
  errs: Errs,
): FileChanges {
  const changes: FileChanges = { uploads: [], removed: [] };
  for (const f of allFields(c)) {
    if (f.type !== "file" || !(f.name in data)) continue;
    const items = fileList(data[f.name]);
    const before = fileList(original?.[f.name]).map(String);
    const kept = isMany(f) ? items : items.slice(-1);
    const added = kept.filter((x): x is string => typeof x === "string" && !before.includes(x));
    if (added.length) {
      errs[f.name] = {
        code: "validation_invalid_file",
        message: `Invalid new files: [${added.map((x) => x.slice(0, 250)).join(" ")}].`,
      };
      continue;
    }
    if (kept.length > maxSelect(f)) {
      errs[f.name] = { code: "validation_too_many_files", message: `The maximum allowed files is ${maxSelect(f)}` };
      continue;
    }
    const names: string[] = [];
    for (const item of kept) {
      if (typeof item === "string") {
        names.push(item);
        continue;
      }
      const error = checkUpload(f, item);
      if (error) {
        errs[f.name] = error;
        break;
      }
      const name = normalizeName(item.name);
      changes.uploads.push({ name, file: item });
      names.push(name);
    }
    if (errs[f.name]) continue;
    changes.removed.push(...before.filter((x) => !names.includes(x)));
    data[f.name] = fromList(f, names);
  }
  return changes;
}

function checkUpload(f: FileField, file: File): { code: string; message: string } | null {
  const original = file.name.slice(0, 300);
  const max = f.maxSize && f.maxSize > 0 ? f.maxSize : DEFAULT_MAX_SIZE;
  if (file.size > max) {
    return {
      code: "validation_file_size_limit",
      message: `Failed to upload ${original} - the maximum allowed file size is ${max} bytes.`,
    };
  }
  if (f.mimeTypes?.length && !f.mimeTypes.includes(file.type.split(";")[0].trim())) {
    return {
      code: "validation_invalid_mime_type",
      message: `${JSON.stringify(original)} mime type must be one of: ${f.mimeTypes.join(", ")}.`,
    };
  }
  return null;
}

/** Every stored file name of a record, for cleanup on delete. */
export function fileNames(c: CollectionConfig, doc: Doc): string[] {
  return allFields(c).filter((f) => f.type === "file").flatMap((f) => fileList(doc[f.name]).map(String));
}
