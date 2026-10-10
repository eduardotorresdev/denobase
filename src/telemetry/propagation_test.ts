import { assertEquals } from "@std/assert";
import { formatTraceparent, injectHeaders, parseTraceparent } from "./propagation.ts";

const T = "4bf92f3577b34da6a3ce929d0e0e4736";
const S = "00f067aa0ba902b7";

Deno.test("traceparent: a valid header gives the caller's trace and span", () => {
  assertEquals(parseTraceparent(`00-${T}-${S}-01`), { traceId: T, spanId: S, sampled: true });
  assertEquals(parseTraceparent(` 00-${T.toUpperCase()}-${S}-00 `), { traceId: T, spanId: S, sampled: false });
});

Deno.test("traceparent: anything invalid is ignored so a fresh trace starts", () => {
  for (
    const h of [
      undefined,
      "",
      "garbage",
      `00-${T}-${S}`,
      `00-${"0".repeat(32)}-${S}-01`,
      `00-${T}-${"0".repeat(16)}-01`,
      `ff-${T}-${S}-01`,
      `00-${T}-${S}-01-extra`,
      `00-${T.slice(1)}-${S}-01`,
    ]
  ) assertEquals(parseTraceparent(h), null, String(h));
});

Deno.test("traceparent: a later version is read by its first four fields", () => {
  assertEquals(parseTraceparent(`01-${T}-${S}-01-future`)?.traceId, T);
});

Deno.test("traceparent: format round-trips and inject sets the header", () => {
  assertEquals(formatTraceparent({ traceId: T, spanId: S }), `00-${T}-${S}-01`);
  assertEquals(parseTraceparent(formatTraceparent({ traceId: T, spanId: S }))?.spanId, S);
  assertEquals(injectHeaders(new Headers(), { traceId: T, spanId: S }).get("traceparent"), `00-${T}-${S}-01`);
  assertEquals(injectHeaders(new Headers(), null).has("traceparent"), false);
});
