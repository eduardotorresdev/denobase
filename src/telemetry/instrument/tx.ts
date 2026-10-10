import { SpanKind } from "../span.ts";
import { traced } from "./child.ts";

/**
 * A `db.transaction` span around one tx() level. fn calls began() when the BEGIN/SAVEPOINT actually runs, so
 * db.tx.wait_ms is the time spent queued behind the connection's other transactions.
 */
export function traceTx<T>(nested: boolean, fn: (began: () => void) => Promise<T>): Promise<T> {
  const queuedAt = performance.now();
  return traced("db.transaction", {
    kind: SpanKind.client,
    attributes: { "db.system.name": "sqlite", "db.tx.savepoint": nested },
  }, (span) =>
    fn(() => {
      span?.setAttribute("db.tx.wait_ms", Math.round((performance.now() - queuedAt) * 1000) / 1000);
    }));
}
