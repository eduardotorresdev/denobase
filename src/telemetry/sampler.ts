import { SpanStatus } from "./span.ts";

/**
 * Head decision from the trace id alone (OTel TraceIdRatioBased): every service that sees the same id agrees.
 * The last 8 hex digits are uniform for random ids, so they make a fraction in [0, 1).
 */
export function headSampled(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return parseInt(traceId.slice(-8), 16) / 0x1_0000_0000 < ratio;
}

/**
 * Tail override: a trace that failed or ran slow is kept even when the head decision (made when the root started,
 * and the one propagated in traceparent) dropped it.
 */
export function keepTrace(
  t: { sampled: boolean; rootStatus: number; hasError: boolean; rootDuration: number },
  cfg: { slowMs: number },
): boolean {
  if (t.hasError || t.rootStatus === SpanStatus.error) return true;
  if (cfg.slowMs > 0 && t.rootDuration >= cfg.slowMs) return true;
  return t.sampled;
}
