import { Trace, type TraceSettings, type TraceSink } from "./buffer.ts";
import { currentSpan, currentTrace, withSpan } from "./context.ts";
import { traceId } from "./ids.ts";
import type { SpanContext } from "./propagation.ts";
import { headSampled, keepTrace } from "./sampler.ts";
import { normalizeSql } from "./sql.ts";
import { type Attrs, NOOP_SPAN, type Span, type SpanOptions, type SpanRecord, SpanStatus } from "./span.ts";
import { tracedFetch } from "./instrument/fetch.ts";

/** What a Tracer writes finished traces to (Spans on the auxiliary db, or a list in tests). */
export interface SpanStore {
  insertMany(spans: SpanRecord[]): void;
}

/** Spans waiting for the flush beyond this are dropped and counted: tracing never grows memory without bound. */
export const MAX_PENDING = 10_000;
/** At most this many spans per scheduled write; the rest wait for the next timer turn, so no write is unbounded. */
export const FLUSH_BATCH = 500;
/** How long terminate() waits for roots still open (requests, jobs in flight) before the last flush. */
export const DRAIN_MS = 2000;

/** Whether err is a refusal (an ApiError 4xx), which does not make a span fail. */
function isClientError(err: unknown): boolean {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" && s >= 400 && s < 500;
}

/**
 * Runs fn as span (made active for everything fn awaits), ends it however fn finishes, and records a thrown error
 * (status error unless it is a 4xx refusal) before rethrowing it.
 */
export async function runInSpan<T>(span: Span, fn: (s: Span) => T | Promise<T>): Promise<T> {
  return await withSpan(span, async () => {
    try {
      return await fn(span);
    } catch (e) {
      failSpan(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** The sync twin of runInSpan, for code that cannot await (node:sqlite calls). */
export function runInSpanSync<T>(span: Span, fn: (s: Span) => T): T {
  return withSpan(span, () => {
    try {
      return fn(span);
    } catch (e) {
      failSpan(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Errors already recorded as an exception event on some span. */
const recorded = new WeakSet<object>();

/**
 * The exception event goes on the span where the error was first seen (OTel); the ancestors it crosses on the way
 * up only get the error status, so the stack is stored once per trace.
 */
export function recordExceptionOnce(span: Span, e: unknown): void {
  if (!span.isRecording) return;
  if (e !== null && typeof e === "object") {
    if (recorded.has(e)) return;
    recorded.add(e);
  }
  span.recordException(e);
}

export function failSpan(span: Span, e: unknown): void {
  recordExceptionOnce(span, e);
  // Writers on several threads share the file: a lock that outlived busy_timeout is worth seeing at a glance.
  if (e instanceof Error && /database is (locked|busy)/i.test(e.message)) span.setAttribute("db.sqlite.busy", true);
  if (!isClientError(e)) span.setStatus(SpanStatus.error, e instanceof Error ? e.message : String(e));
}

/**
 * The app's tracer (app.tracer): starts traces and spans, keeps each trace until its root ends, then samples it and
 * queues it for one batched write. Recording never blocks the work: writes run on a timer, FLUSH_BATCH spans at a
 * time. Spans of roots still open when terminate()'s drain times out are lost (counted in dropped).
 */
export class Tracer implements TraceSink {
  /** Spans lost to the pending limit since start. */
  dropped = 0;
  readonly #pending: SpanRecord[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Roots started and not finished yet. */
  #inflight = 0;
  #closed = false;

  constructor(readonly store: SpanStore, readonly cfg: () => TraceSettings) {}

  settings(): TraceSettings {
    return this.cfg();
  }

  get enabled(): boolean {
    const c = this.cfg();
    return c.enabled && c.maxDays > 0;
  }

  /** A new trace (or the local part of a remote one, when parent comes from an incoming traceparent). */
  startRoot(
    name: string,
    opts: SpanOptions & { parent?: SpanContext | null; maxSpans?: number; keep?: boolean } = {},
  ): Span {
    if (!this.enabled || this.#closed) return NOOP_SPAN;
    const id = opts.parent?.traceId ?? traceId();
    // Parent-based: a caller's decision (only reaches here when traceparent is trusted) wins over the local ratio;
    // `keep` (cron runs, backups) is always sampled.
    const sampled = opts.parent?.sampled ?? (opts.keep || headSampled(id, this.cfg().sampleRatio));
    const trace = new Trace(this, id, sampled);
    if (opts.maxSpans) trace.maxSpans = opts.maxSpans;
    this.#inflight++;
    return trace.start(name, opts.parent?.spanId ?? "", true, opts);
  }

  /** A child of the active span, or a new trace when none is active; end() is the caller's. */
  startSpan(name: string, opts: SpanOptions = {}): Span {
    const parent = currentSpan();
    return parent ? parent.trace!.start(name, parent.id, false, opts) : this.startRoot(name, opts);
  }

  /** Runs fn inside a span that ends with it; a thrown error is recorded on the span and rethrown. */
  span<T>(name: string, attrs: Attrs | undefined, fn: (s: Span) => T | Promise<T>): Promise<T> {
    return runInSpan(this.startSpan(name, { attributes: attrs }), fn);
  }

  /**
   * Runs fn as the root of a trace of its own, even inside another one: work that outlives what started it (a reply
   * built after the request answered 202, a queued message) would otherwise be cut when that trace ends. The trace
   * it started from, if any, stays as `link.trace_id`/`link.span_id`, the flat form of an OTel span link.
   */
  root<T>(
    name: string,
    opts: SpanOptions & { maxSpans?: number; link?: { traceId: string; spanId: string } | null },
    fn: (s: Span) => T | Promise<T>,
  ): Promise<T> {
    const link = opts.link === undefined ? currentTrace() : opts.link;
    const span = this.startRoot(name, { ...opts, parent: null });
    if (link) span.setAttributes({ "link.trace_id": link.traceId, "link.span_id": link.spanId });
    return runInSpan(span, fn);
  }

  current(): { traceId: string; spanId: string } | null {
    return currentTrace();
  }

  /** fetch that opens a client span and sends traceparent. */
  readonly fetch: typeof fetch = (input, init) => tracedFetch(input, init);

  finish(trace: Trace): void {
    if (this.#inflight > 0) this.#inflight--;
    const c = this.cfg();
    const root = trace.spans.find((s) => s.root);
    if (!root) return;
    const keep = keepTrace({
      sampled: trace.sampled,
      rootStatus: root.status,
      hasError: trace.hasError,
      rootDuration: root.duration,
    }, c);
    if (!keep) return;
    if (this.#closed) {
      this.dropped += trace.spans.length;
      return;
    }
    let spans = c.minDurationMs > 0 ? trace.spans.filter((s) => s.root || s.duration >= c.minDurationMs) : trace.spans;
    spans = trace.connect(spans);
    // A head-dropped trace kept by the tail skipped the SQL normalization while it ran (see traceQuery).
    if (!trace.sampled) spans = spans.map(normalizeDeferred);
    if (this.#pending.length + spans.length > MAX_PENDING) {
      this.dropped += spans.length;
      return;
    }
    this.#pending.push(...spans);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== undefined || !this.#pending.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#write(FLUSH_BATCH);
      this.#schedule();
    }, 0);
  }

  #write(max: number): void {
    if (!this.#pending.length) return;
    const batch = this.#pending.splice(0, max);
    try {
      this.store.insertMany(batch);
    } catch (e) {
      this.dropped += batch.length;
      console.error("traces flush failed", e);
    }
  }

  /** Writes every pending span now (tests call it; terminate() goes through drain()). */
  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#write(Infinity);
  }

  /**
   * Shutdown: waits up to timeoutMs for open roots (requests and jobs in flight) to finish, writes everything, and
   * stops recording, so no write runs after the host closes the auxiliary db.
   */
  async drain(timeoutMs = DRAIN_MS): Promise<void> {
    const until = performance.now() + timeoutMs;
    while (this.#inflight > 0 && performance.now() < until) await new Promise((r) => setTimeout(r, 10));
    this.flush();
    this.#closed = true;
  }

  get pending(): number {
    return this.#pending.length;
  }
}

function normalizeDeferred(s: SpanRecord): SpanRecord {
  const text = s.attributes["db.query.text"];
  return typeof text === "string" ? { ...s, attributes: { ...s.attributes, "db.query.text": normalizeSql(text) } } : s;
}
