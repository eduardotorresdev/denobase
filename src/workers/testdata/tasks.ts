/** Test task: echoes, fails on demand or burns CPU, to prove it runs off the main thread. */
export default function testTask(input: { fail?: boolean; spin?: number; value?: string }): Uint8Array | string {
  if (input.fail) throw new Error("task failed on purpose");
  if (input.spin) {
    const until = performance.now() + input.spin;
    while (performance.now() < until) { /* busy */ }
    return new TextEncoder().encode("spun");
  }
  return `echo:${input.value}`;
}
