import type { DatabaseSync } from "node:sqlite";
import { collections } from "../core/registry.ts";
import { selectRow } from "../store/sqlite.ts";
import { notifyRemote, onRecordEvent, type RecordAction } from "./events.ts";

interface Wire {
  slug: string;
  id: string;
  action: RecordAction;
  row?: Record<string, unknown>;
}

/**
 * Relays the record writes of this thread's connection to the other threads on the same db file, and theirs to this
 * thread's remote listeners (notifyRemote), over a BroadcastChannel named after the file. Posted after the commit,
 * so a receiver reads the committed row; a delete carries the row it removed. Returns the function that stops it.
 */
export function shareRecordEvents(db: DatabaseSync, path: string): () => void {
  const channel = new BroadcastChannel(`denobase:records:${path}`);
  const off = onRecordEvent({
    changed: (e) => {
      if (e.db !== db || e.remote) return;
      channel.postMessage({ slug: e.collection.slug, id: e.id, action: e.action } satisfies Wire);
    },
    deleting: (e) => {
      if (e.db !== db || e.remote) return Promise.resolve();
      const row = selectRow(db, e.collection.slug, e.id);
      return Promise.resolve(() => channel.postMessage({ slug: e.collection.slug, id: e.id, action: "delete", row }));
    },
  });
  channel.onmessage = (m: MessageEvent<Wire>) => {
    const collection = collections.find((c) => c.slug === m.data.slug);
    if (!collection) return;
    notifyRemote({ db, collection, id: m.data.id, action: m.data.action, remote: true, row: m.data.row });
  };
  return () => {
    off();
    channel.close();
  };
}
