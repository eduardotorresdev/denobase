import type { CollectionSnapshot, MigrationOp, Snapshot } from "./types.ts";
import { canon, clone, indexesByName } from "./snapshot.ts";

/** Pure snapshot algebra: the ops between two snapshots and applying ops to one. */

/** Pure: ops turning `from` into `to`. */
export function diff(from: Snapshot, to: Snapshot): MigrationOp[] {
  const ops: MigrationOp[] = [];
  for (const slug of Object.keys(from)) if (!to[slug]) ops.push({ op: "dropCollection", slug });
  for (const [slug, t] of Object.entries(to)) {
    const f = from[slug];
    if (!f) {
      ops.push({ op: "createCollection", collection: clone(t) });
      continue;
    }
    if (!!f.view !== !!t.view) {
      ops.push({ op: "dropCollection", slug }, { op: "createCollection", collection: clone(t) });
      continue;
    }
    if (t.view) {
      if (canon(f) !== canon(t)) ops.push({ op: "alterView", collection: clone(t) });
      continue;
    }
    if (f.auth !== t.auth) throw new Error(`collection ${slug}: changing auth is not a supported migration`);
    const fIdx = new Map(f.indexes.map((i) => [i.name!, i]));
    const tIdx = new Map(t.indexes.map((i) => [i.name!, i]));
    const idxChanged = (n: string) => canon(fIdx.get(n)) !== canon(tIdx.get(n));
    // Indexes go first so a removed/altered column never has a dangling index during the rebuild.
    for (const n of fIdx.keys()) if (!tIdx.has(n) || idxChanged(n)) ops.push({ op: "dropIndex", slug, name: n });
    const fFields = new Map(f.fields.map((x) => [x.name, x]));
    const tFields = new Map(t.fields.map((x) => [x.name, x]));
    for (const n of fFields.keys()) if (!tFields.has(n)) ops.push({ op: "removeField", slug, name: n });
    for (const [n, x] of tFields) {
      const old = fFields.get(n);
      if (!old) ops.push({ op: "addField", slug, field: clone(x) });
      else if (canon(old) !== canon(x)) ops.push({ op: "alterField", slug, field: clone(x) });
    }
    for (const [n, i] of tIdx) if (!fIdx.has(n) || idxChanged(n)) ops.push({ op: "addIndex", slug, index: clone(i) });
  }
  return ops;
}

export function need(s: Snapshot, slug: string): CollectionSnapshot {
  const c = s[slug];
  if (!c) throw new Error(`unknown collection in migration: ${slug}`);
  return c;
}

/** Pure: applies ops to a snapshot. */
export function applyOps(s: Snapshot, ops: MigrationOp[]): Snapshot {
  const out = clone(s);
  for (const o of ops) {
    switch (o.op) {
      case "createCollection":
        if (out[o.collection.slug]) throw new Error(`collection already exists: ${o.collection.slug}`);
        out[o.collection.slug] = clone(o.collection);
        break;
      case "dropCollection":
        need(out, o.slug);
        delete out[o.slug];
        break;
      case "addField": {
        const c = need(out, o.slug);
        if (c.fields.some((f) => f.name === o.field.name)) throw new Error(`field exists: ${o.slug}.${o.field.name}`);
        c.fields.push(clone(o.field));
        break;
      }
      case "removeField": {
        const c = need(out, o.slug);
        c.fields = c.fields.filter((f) => f.name !== o.name);
        break;
      }
      case "alterField": {
        const c = need(out, o.slug);
        const i = c.fields.findIndex((f) => f.name === o.field.name);
        if (i < 0) throw new Error(`unknown field: ${o.slug}.${o.field.name}`);
        c.fields[i] = clone(o.field);
        break;
      }
      case "addIndex":
        need(out, o.slug).indexes.push(clone(o.index));
        break;
      case "dropIndex": {
        const c = need(out, o.slug);
        c.indexes = c.indexes.filter((i) => i.name !== o.name);
        break;
      }
      case "alterView":
        need(out, o.collection.slug);
        out[o.collection.slug] = clone(o.collection);
        break;
    }
  }
  return indexesByName(out);
}

/**
 * Applies ops tolerating overlap between merged branches: re-adding an existing field or collection replaces it,
 * removing or dropping a missing one is a no-op, altering a missing field adds it.
 */
export function applyOpsLenient(s: Snapshot, ops: MigrationOp[]): Snapshot {
  let out = clone(s);
  for (const o of ops) {
    const has = (slug: string) => !!out[slug];
    const hasField = (slug: string, n: string) => !!out[slug]?.fields.some((f) => f.name === n);
    switch (o.op) {
      case "createCollection":
        out[o.collection.slug] = clone(o.collection);
        break;
      case "dropCollection":
        delete out[o.slug];
        break;
      case "addField":
      case "alterField":
        if (!has(o.slug)) throw new Error(`unknown collection in migration: ${o.slug}`);
        out = applyOps(out, [hasField(o.slug, o.field.name) ? { ...o, op: "alterField" } : { ...o, op: "addField" }]);
        break;
      case "removeField":
        if (hasField(o.slug, o.name)) out = applyOps(out, [o]);
        break;
      case "addIndex":
        if (!has(o.slug)) throw new Error(`unknown collection in migration: ${o.slug}`);
        out[o.slug].indexes = out[o.slug].indexes.filter((i) => i.name !== o.index.name);
        out = applyOps(out, [o]);
        break;
      case "dropIndex":
        if (has(o.slug)) out = applyOps(out, [o]);
        break;
      case "alterView":
        out[o.collection.slug] = clone(o.collection);
        break;
    }
  }
  return indexesByName(out);
}

/** Strict ops that move `s` to where the (possibly overlapping) op leaves it; [] when it is already there. */
export function normalizeOp(s: Snapshot, op: MigrationOp): MigrationOp[] {
  return diff(s, applyOpsLenient(s, [op]));
}
