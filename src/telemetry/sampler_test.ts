import { assertEquals } from "@std/assert";
import { headSampled, keepTrace } from "./sampler.ts";
import { traceId } from "./ids.ts";

const id = (tail: string) => "a".repeat(32 - tail.length) + tail;

Deno.test("sampler: ratio 1 keeps all, ratio 0 keeps none", () => {
  for (let i = 0; i < 50; i++) {
    const t = traceId();
    assertEquals([headSampled(t, 1), headSampled(t, 0)], [true, false]);
  }
});

Deno.test("sampler: ratio 0.5 is decided by the trace id alone, the same every time", () => {
  assertEquals(headSampled(id("00000000"), 0.5), true);
  assertEquals(headSampled(id("7fffffff"), 0.5), true);
  assertEquals(headSampled(id("80000000"), 0.5), false);
  assertEquals(headSampled(id("ffffffff"), 0.5), false);
  const t = traceId();
  assertEquals(headSampled(t, 0.5), headSampled(t, 0.5));
  const kept = Array.from({ length: 4000 }, traceId).filter((x) => headSampled(x, 0.5)).length;
  assertEquals(kept > 1700 && kept < 2300, true, String(kept));
});

Deno.test("sampler: a failed or slow trace is kept even when the head decision dropped it", () => {
  const cfg = { slowMs: 1000 };
  const base = { sampled: false, rootStatus: 0, hasError: false, rootDuration: 5 };
  assertEquals(keepTrace(base, cfg), false);
  assertEquals(keepTrace({ ...base, sampled: true }, cfg), true);
  assertEquals(keepTrace({ ...base, hasError: true }, cfg), true);
  assertEquals(keepTrace({ ...base, rootStatus: 2 }, cfg), true);
  assertEquals(keepTrace({ ...base, rootDuration: 1000 }, cfg), true);
  assertEquals(keepTrace({ ...base, rootDuration: 5000 }, { slowMs: 0 }), false);
});
