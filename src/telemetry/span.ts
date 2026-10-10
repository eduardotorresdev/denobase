import type { Trace } from "./buffer.ts";
import { spanId } from "./ids.ts";

/** OTel SpanKind, stored as its number. */
export const SpanKind = { internal: 0, server: 1, client: 2, producer: 3, consumer: 4 } as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** OTel StatusCode: 4xx answers stay unset, like the HTTP semconv says for server spans. */
export const SpanStatus = { unset: 0, ok: 1, error: 2 } as const;
export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];

export type AttrValue = string | number | boolean | null | (string | number | boolean)[];
export type Attrs = Record<string, AttrValue | undefined>;

export interface SpanEvent {
  name: string;
  /** Epoch microseconds. */
  time: number;
  attributes?: Attrs;
}

/** One finished span, the row `_spans` keeps. */
export interface SpanRecord {
  id: string;
  traceId: string;
  /** '' on a trace root that has no remote parent. */
  parentId: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  /** Epoch microseconds. */
  start: number;
  /** Milliseconds. */
  duration: number;
  /** The local root of the trace (what the traces list shows), even when parentId names a remote caller. */
  root: boolean;
  attributes: Attrs;
  events: SpanEvent[];
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attrs;
}

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const SECRET =
  /\b(token|password|passwd|secret|api[_-]?key|authorization|bearer)(["']?\s*[:=]\s*|\s+)["']?[^\s"',;&]+/gi;

/**
 * Free error text bound for a span (exception.message, stacktrace, status.message): cut, with e-mail addresses and
 * `token=...`-style secrets masked, since a thrown message may echo a recipient, a payload or a provider's body.
 */
export function scrub(text: string, max: number): string {
  return text.slice(0, max * 2).replace(EMAIL, "[email]").replace(SECRET, "$1$2[redacted]").slice(0, max);
}

/** Epoch µs with sub-ms precision: timeOrigin + the monotonic clock. */
export const nowMicros = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000);

/**
 * A unit of work in a trace. Spans of a disabled tracer are the NOOP_SPAN, so instrumented code never branches.
 * end() is idempotent; a span ended after its trace's root finished is dropped.
 */
export class Span {
  readonly id: string;
  readonly #t0 = performance.now();
  #rec: SpanRecord;
  #ended = false;

  constructor(
    readonly trace: Trace | null,
    name: string,
    parentId: string,
    root: boolean,
    opts: SpanOptions = {},
  ) {
    this.id = trace ? spanId() : "0".repeat(16);
    this.#rec = {
      id: this.id,
      traceId: trace?.traceId ?? "0".repeat(32),
      parentId,
      name,
      kind: opts.kind ?? SpanKind.internal,
      status: SpanStatus.unset,
      start: nowMicros(),
      duration: 0,
      root,
      attributes: { ...opts.attributes },
      events: [],
    };
  }

  get traceId(): string {
    return this.#rec.traceId;
  }

  get name(): string {
    return this.#rec.name;
  }

  /** False once ended, or once its trace's root ended (late children are not collected). */
  get isRecording(): boolean {
    return this.trace !== null && !this.#ended && !this.trace.done;
  }

  /** The trace's head sampling decision (what traceparent tells callees). */
  get sampled(): boolean {
    return this.trace?.sampled ?? false;
  }

  get status(): SpanStatus {
    return this.#rec.status;
  }

  updateName(name: string): this {
    if (this.trace) this.#rec.name = name;
    return this;
  }

  setAttribute(key: string, value: AttrValue | undefined): this {
    if (this.trace && value !== undefined) this.#rec.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Attrs): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }

  addEvent(name: string, attributes?: Attrs): this {
    if (this.trace) this.#rec.events.push({ name, time: nowMicros(), ...(attributes ? { attributes } : {}) });
    return this;
  }

  /** OTel exception event; the status is the caller's call (a 4xx refusal is not a failure of the span). */
  recordException(err: unknown): this {
    const e = err instanceof Error ? err : new Error(String(err));
    return this.addEvent("exception", {
      "exception.type": e.name,
      "exception.message": scrub(e.message, 500),
      "exception.stacktrace": scrub(e.stack ?? "", 4000),
    });
  }

  setStatus(status: SpanStatus, message?: string): this {
    // OTel: Ok is final; Error can still be overridden by Ok, Unset never overrides.
    if (!this.trace || status === SpanStatus.unset || this.#rec.status === SpanStatus.ok) return this;
    this.#rec.status = status;
    if (status === SpanStatus.error && message) this.#rec.attributes["status.message"] = scrub(message, 500);
    return this;
  }

  end(): void {
    if (!this.trace || this.#ended) return;
    this.#ended = true;
    this.#rec.duration = performance.now() - this.#t0;
    this.trace.ended(this.#rec);
  }
}

/** The span every call gets when tracing is off or there is no trace around: records nothing. */
export const NOOP_SPAN: Span = new Span(null, "", "", false);
