/**
 * Native tracing: our own tracer, OTel-shaped (W3C traceparent, 32/16 hex ids, kind, status, events, current semconv
 * names) without the SDK, so an OTLP exporter can be added later without changing the model. Spans live in the
 * auxiliary db's _spans, beside _logs.
 */
export { type Attrs, type AttrValue, NOOP_SPAN, Span, SpanKind, type SpanRecord, SpanStatus } from "./span.ts";
export { Trace, type TraceSettings, type TraceSink } from "./buffer.ts";
export { currentSpan, currentTrace, withSpan } from "./context.ts";
export { formatTraceparent, injectHeaders, parseTraceparent, type SpanContext } from "./propagation.ts";
export { headSampled, keepTrace } from "./sampler.ts";
export { normalizeSql } from "./sql.ts";
export { FLUSH_BATCH, MAX_PENDING, runInSpan, runInSpanSync, type SpanStore, Tracer } from "./tracer.ts";
export { type SpanNode, Spans, type StoredSpan, type TraceStats, type TraceSummary } from "./store.ts";
export { tracedFetch } from "./instrument/fetch.ts";
export { traced, tracedSync } from "./instrument/child.ts";
