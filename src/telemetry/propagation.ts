/** W3C traceparent (version 00): `00-<32 hex trace>-<16 hex span>-<2 hex flags>`. */
export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Bit 0 of the trace flags: the caller sampled this trace. */
  sampled?: boolean;
}

const RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The caller's context, or null for anything invalid (a fresh trace starts instead, as the spec says). */
export function parseTraceparent(h: string | null | undefined): SpanContext | null {
  const m = RE.exec((h ?? "").trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m;
  // Version ff is forbidden; version 00 carries nothing after the flags. Later versions may extend the header.
  if (version === "ff" || (version === "00" && rest)) return null;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled === false ? "00" : "01"}`;
}

/** Sets traceparent on outgoing headers so the callee joins this trace. */
export function injectHeaders(headers: Headers, ctx: SpanContext | null): Headers {
  if (ctx) headers.set("traceparent", formatTraceparent(ctx));
  return headers;
}
