import type { Migration, Snapshot } from "./types.ts";
import { applyOpsLenient } from "./ops.ts";

/** Migrations form a DAG (branches merge through reconcile): order, heads and the replayed schema. */

/** Topological order; ties broken by id for determinism. */
export function topoSort(ms: Migration[]): Migration[] {
  const seen = new Set<string>();
  for (const m of ms) {
    if (seen.has(m.id)) throw new Error(`duplicate migration id: ${m.id}`);
    seen.add(m.id);
  }
  const byId = new Map(ms.map((m) => [m.id, m]));
  const indeg = new Map(ms.map((m) => [m.id, 0]));
  const children = new Map<string, string[]>();
  for (const m of ms) {
    for (const p of m.parents) {
      if (!byId.has(p)) throw new Error(`migration ${m.id}: unknown parent ${p}`);
      indeg.set(m.id, indeg.get(m.id)! + 1);
      children.set(p, [...(children.get(p) ?? []), m.id]);
    }
  }
  const ready = [...indeg].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const out: Migration[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const c of children.get(id) ?? []) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) {
        ready.push(c);
        ready.sort();
      }
    }
  }
  if (out.length !== ms.length) throw new Error("migration graph has a cycle");
  return out;
}

/** Migrations nobody lists as parent. */
export function heads(ms: Migration[]): string[] {
  const parents = new Set(ms.flatMap((m) => m.parents));
  return ms.map((m) => m.id).filter((id) => !parents.has(id)).sort();
}

/** Replays every migration from empty; the snapshot file is only a cache of this. Merged branches may overlap. */
export function replay(ms: Migration[]): Snapshot {
  return topoSort(ms).reduce((s, m) => applyOpsLenient(s, m.ops), {} as Snapshot);
}
