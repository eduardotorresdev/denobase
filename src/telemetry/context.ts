import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "./span.ts";

/**
 * The active span per async context, apart from core/db's tx frame: each request, cron run or worker task sees its
 * own, and awaits, Promise.all branches and timers keep the span that was active where they started.
 */
const active = new AsyncLocalStorage<Span>();

/**
 * The span code runs under while it still records. Once it ended (work left running with `void`), its nearest open
 * ancestor takes over, so the work stays in the trace until the root ends; a finished trace collects nothing.
 */
export function currentSpan(): Span | undefined {
  const s = active.getStore();
  if (!s) return undefined;
  return s.isRecording ? s : s.trace?.nearestOpen(s.id);
}

export function withSpan<T>(span: Span, fn: () => T): T {
  return active.run(span, fn);
}

/** Ids to stamp on logs and outgoing calls, or null outside a trace. */
export function currentTrace(): { traceId: string; spanId: string } | null {
  const s = currentSpan();
  return s ? { traceId: s.traceId, spanId: s.id } : null;
}
