/**
 * Log-scale latency buckets (about 10% wide), shared by the spans and requests rollups so their percentiles agree:
 * bucket k holds durations up to HIST_BASE * HIST_STEP^k ms.
 */
const HIST_BASE = 0.01, HIST_STEP = 1.1, HIST_MAX = 260;
export const histIndex = (ms: number) =>
  !(ms > HIST_BASE) ? 0 : Math.min(HIST_MAX, Math.ceil(Math.log(ms / HIST_BASE) / Math.log(HIST_STEP)));
export const histValue = (k: number) => HIST_BASE * HIST_STEP ** k;

/** Nearest rank over a histogram: the upper bound of the bucket holding the p-th value; null when empty. */
export function histQuantile(hist: Map<number, number>, total: number, p: number): number | null {
  if (!total) return null;
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const k of [...hist.keys()].sort((a, b) => a - b)) if ((seen += hist.get(k)!) >= rank) return histValue(k);
  return null;
}
