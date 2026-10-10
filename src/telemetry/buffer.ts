import { Span, type SpanOptions, type SpanRecord, SpanStatus } from "./span.ts";

/** settings.traces: what is recorded and for how long. */
export interface TraceSettings {
  enabled: boolean;
  /** Head sampling ratio in [0, 1], decided from the trace id when the root starts. */
  sampleRatio: number;
  /** Retention; 0 records nothing (like logs.maxDays). */
  maxDays: number;
  /** Child spans faster than this are dropped; the root never is. */
  minDurationMs: number;
  /** A trace whose root takes at least this long is kept whatever the sampling said. */
  slowMs: number;
  maxSpansPerTrace: number;
  /** db.query.text (normalized, no literals) on db spans. */
  recordDbText: boolean;
  /**
   * Join the trace of an incoming traceparent (id and sampled flag). Off by default: any client could pick the trace
   * id (and so the head decision) or attach roots to someone else's trace. Turn on only behind a trusted proxy.
   */
  trustTraceparent: boolean;
  /** Hosts (and their subdomains) outgoing fetches send traceparent to; every other host gets no trace ids. */
  propagateHosts: string[];
}

/** Where a trace goes once its root ends: the app's Tracer, or a worker's collector. */
export interface TraceSink {
  settings(): TraceSettings;
  finish(trace: Trace): void;
}

/**
 * The spans of one trace in this process, held until the local root ends: only then can the tail decision (error,
 * slow) be made, and the whole trace leaves in one batch, so the store never sees half a trace.
 */
export class Trace {
  readonly spans: SpanRecord[] = [];
  dropped = 0;
  hasError = false;
  done = false;
  /** The parent of every span this trace saw, kept or not, so a dropped span's children can be re-parented. */
  readonly #parentOf = new Map<string, string>();
  /** Spans started and not ended yet. */
  readonly #open = new Map<string, Span>();

  /** The span cap of this trace when its root asked for one above settings.maxSpansPerTrace (a long agent turn). */
  maxSpans?: number;

  /** sampled is the head decision, made once when the root starts and propagated downstream. */
  constructor(readonly sink: TraceSink, readonly traceId: string, readonly sampled = true) {}

  start(name: string, parentId: string, root: boolean, opts?: SpanOptions): Span {
    const span = new Span(this, name, parentId, root, opts);
    this.#parentOf.set(span.id, parentId);
    this.#open.set(span.id, span);
    return span;
  }

  /**
   * The closest ancestor of span id that still records: work an ended span left running (a `void` publish or fetch)
   * still belongs to the trace while its root is open.
   */
  nearestOpen(id: string): Span | undefined {
    if (this.done) return undefined;
    for (let p = this.#parentOf.get(id); p !== undefined; p = this.#parentOf.get(p)) {
      const s = this.#open.get(p);
      if (s?.isRecording) return s;
    }
    return undefined;
  }

  /** Called by Span.end(). */
  ended(rec: SpanRecord): void {
    this.#open.delete(rec.id);
    if (this.done) return;
    if (rec.status === SpanStatus.error) this.hasError = true;
    if (rec.root) {
      if (this.dropped) {
        rec.attributes["denobase.spans_dropped"] = this.dropped;
        // A truncated trace is never silent: the cut is on the root and in the log, with the cap that made it.
        console.warn("traces: trace truncada no limite de spans", {
          traceId: this.traceId,
          root: rec.name,
          limite: this.#cap(),
          descartados: this.dropped,
        });
      }
      this.spans.push(rec);
      this.done = true;
      this.#open.clear();
      this.sink.finish(this);
      return;
    }
    // One slot stays for the root. Children end before their parents, so what is dropped here may be an ancestor
    // of kept spans: connect() re-parents those before the trace leaves.
    if (this.spans.length >= this.#cap() - 1) this.dropped++;
    else this.spans.push(rec);
  }

  #cap(): number {
    return Math.max(1, this.sink.settings().maxSpansPerTrace, this.maxSpans ?? 0);
  }

  /** Spans a worker recorded under this trace (it cannot write them itself); they are never roots here. */
  adopt(recs: SpanRecord[]): void {
    for (const r of recs) {
      if (r.traceId !== this.traceId) continue;
      this.#parentOf.set(r.id, r.parentId);
      this.ended({ ...r, root: false });
    }
  }

  /**
   * kept, with every span whose parent was dropped (span limit, minDurationMs) hung from its nearest kept ancestor,
   * so the stored tree has no orphans. A parent this trace never saw (the remote caller) stays as is.
   */
  connect(kept: SpanRecord[]): SpanRecord[] {
    const ids = new Set(kept.map((s) => s.id));
    return kept.map((s) => {
      if (s.root || ids.has(s.parentId) || !this.#parentOf.has(s.parentId)) return s;
      let p = this.#parentOf.get(s.parentId);
      while (p !== undefined && !ids.has(p)) p = this.#parentOf.get(p);
      return p === undefined ? s : { ...s, parentId: p };
    });
  }
}
