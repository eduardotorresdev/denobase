import { currentSpan } from "../context.ts";
import type { Span, SpanOptions } from "../span.ts";
import { runInSpan, runInSpanSync } from "../tracer.ts";

/**
 * Library code (store, engine, realtime...) has no tracer in hand: it only adds children to a trace something else
 * started (a request, a cron run). Outside a trace these run fn as is, so untraced work pays one ALS lookup.
 */
export function childSpan(name: string, opts?: SpanOptions): Span | null {
  const parent = currentSpan();
  return parent ? parent.trace!.start(name, parent.id, false, opts) : null;
}

export function traced<T>(name: string, opts: SpanOptions, fn: (s?: Span) => T | Promise<T>): Promise<T> {
  const span = childSpan(name, opts);
  if (span) return runInSpan(span, fn);
  // Untraced, fn still starts synchronously, as it would without instrumentation (tx() relies on that order).
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

export function tracedSync<T>(name: string, opts: SpanOptions, fn: (s?: Span) => T): T {
  const span = childSpan(name, opts);
  return span ? runInSpanSync(span, fn) : fn();
}

/** The settings of the trace around, for instrumentation that reads them (recordDbText). */
export function traceSettings() {
  return currentSpan()?.trace?.sink.settings();
}
