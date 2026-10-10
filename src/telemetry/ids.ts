/** W3C trace context ids: 16 random bytes for a trace, 8 for a span, lowercase hex, never all zeros. */
function hex(bytes: number): string {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(bytes));
    if (b.some((x) => x !== 0)) return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
}

export const traceId = (): string => hex(16);
export const spanId = (): string => hex(8);
