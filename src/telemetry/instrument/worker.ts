import type { Trace, TraceSettings, TraceSink } from "../buffer.ts";
import { Trace as TraceBuffer } from "../buffer.ts";
import { currentSpan } from "../context.ts";
import { formatTraceparent, parseTraceparent } from "../propagation.ts";
import { SpanKind, type SpanRecord } from "../span.ts";
import { runInSpan } from "../tracer.ts";
import { childSpan, traceSettings } from "./child.ts";

/** Workers cannot write to the auxiliary db of the main thread: their spans travel back with the result. */
export class Collector implements TraceSink {
  spans: SpanRecord[] = [];
  constructor(readonly cfg: TraceSettings) {}
  settings(): TraceSettings {
    return this.cfg;
  }
  finish(trace: Trace): void {
    this.spans.push(...trace.connect(trace.spans));
  }
}

/** A task that failed in a worker, with the spans it recorded before failing. */
export class TaskFailed extends Error {
  constructor(message: string, readonly spans: SpanRecord[] = []) {
    super(message);
  }
}

/** Main thread: the `worker <task>` span around runTask, and the traceparent and settings to hand the worker. */
export async function traceWorkerRun<O>(
  module: URL,
  run: (
    traceparent: string | undefined,
    settings: TraceSettings | undefined,
  ) => Promise<{ output: O; spans?: SpanRecord[] }>,
): Promise<O> {
  const name = module.pathname.split("/").pop()?.replace(/\.ts$/, "") ?? "task";
  const span = childSpan(`worker ${name}`, { kind: SpanKind.producer, attributes: { "worker.module": name } });
  if (!span) return (await run(undefined, undefined)).output;
  const settings = traceSettings();
  return await runInSpan(span, async () => {
    const adopt = (spans?: SpanRecord[]) => spans?.length && currentSpan()?.trace?.adopt(spans);
    try {
      const { output, spans } = await run(
        formatTraceparent({ traceId: span.traceId, spanId: span.id, sampled: span.sampled }),
        settings,
      );
      adopt(spans);
      return output;
    } catch (e) {
      // What ran before the failure is the detail that matters most: it joins the trace before the error goes up.
      if (e instanceof TaskFailed) adopt(e.spans);
      throw e;
    }
  });
}

/**
 * Worker side: runs the task under a span whose parent is the main thread's, with the app's trace settings (sampling
 * and filtering stay the main thread's call), and returns what it recorded. A failure rethrows as TaskFailed,
 * carrying the spans.
 */
export async function traceInWorker<O>(
  traceparent: string | undefined,
  settings: TraceSettings | undefined,
  module: string,
  fn: () => Promise<O>,
): Promise<{ output: O; spans?: SpanRecord[] }> {
  const parent = parseTraceparent(traceparent);
  if (!parent || !settings) return { output: await fn() };
  const collector = new Collector({ ...settings, enabled: true, sampleRatio: 1, minDurationMs: 0, slowMs: 0 });
  const trace = new TraceBuffer(collector, parent.traceId, parent.sampled !== false);
  const span = trace.start(`task ${module.split("/").pop()?.replace(/\.ts$/, "")}`, parent.spanId, true, {
    kind: SpanKind.consumer,
  });
  try {
    const output = await runInSpan(span, fn);
    return { output, spans: collector.spans };
  } catch (e) {
    throw new TaskFailed(e instanceof Error ? e.message : String(e), collector.spans);
  }
}
