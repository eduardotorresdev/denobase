import type { DatabaseSync } from "node:sqlite";
import type { CollectionConfig } from "../core/types.ts";
import { afterCommit } from "../core/db.ts";

export type RecordAction = "create" | "update" | "delete";

export interface RecordEvent {
  db: DatabaseSync;
  collection: CollectionConfig;
  id: string;
  action: RecordAction;
  /** Committed by another thread's connection (the job worker, another HTTP isolate) and relayed here. */
  remote?: boolean;
  /** A delete from another thread: the row as it was, raw columns (the row is gone here). */
  row?: Record<string, unknown>;
}

/** Whoever reacts to record writes (realtime). Listeners only ever see committed changes. */
export interface RecordListener {
  /** After the create/update committed; fire and forget, like PB's OnModelAfter*Success. */
  changed?(e: RecordEvent): void | Promise<void>;
  /**
   * Inside the delete tx, before the row goes, so access can still be checked against it (PB's dry cache).
   * The returned function runs once the delete commits; a rollback drops it.
   */
  deleting?(e: RecordEvent): Promise<(() => void) | void>;
  /**
   * Also hear writes committed by other threads (relayed after their commit; see engine/bus.ts). For what must react
   * in every thread that holds clients (realtime), or in the one thread that owns a singleton (a WhatsApp sender).
   * Without it a listener only hears the writes of its own thread, like a hook: the thread that writes runs it.
   */
  remote?: boolean;
  /** A delete committed by another thread, with the row it had (e.row). */
  deletedElsewhere?(e: RecordEvent): void | Promise<void>;
}

const listeners = new Set<RecordListener>();

/** Registers a listener; returns the function that removes it. */
export function onRecordEvent(l: RecordListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function report(e: unknown): void {
  console.error("record listener failed:", e);
}

export function notifyChanged(e: RecordEvent): void {
  if (!listeners.size) return;
  afterCommit(e.db, () => {
    for (const l of listeners) {
      try {
        Promise.resolve(l.changed?.(e)).catch(report);
      } catch (err) {
        report(err);
      }
    }
  });
}

export async function notifyDeleting(e: RecordEvent): Promise<void> {
  if (!listeners.size) return;
  const sends: (() => void)[] = [];
  for (const l of listeners) {
    try {
      const send = await l.deleting?.(e);
      if (send) sends.push(send);
    } catch (err) {
      report(err);
    }
  }
  if (sends.length) afterCommit(e.db, () => sends.forEach((s) => s()));
}

/** A write another thread committed, to the listeners that hear remote writes. */
export function notifyRemote(e: RecordEvent): void {
  for (const l of listeners) {
    if (!l.remote) continue;
    try {
      const r = e.action === "delete" ? l.deletedElsewhere?.(e) : l.changed?.(e);
      Promise.resolve(r).catch(report);
    } catch (err) {
      report(err);
    }
  }
}
