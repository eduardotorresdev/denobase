import type { TraceSettings } from "../telemetry/buffer.ts";

/** Messages between the main thread and the task worker (host.ts). */
export interface TaskRequest {
  module: string;
  input: unknown;
  /** The main thread's span, when the run is traced. */
  traceparent?: string;
  /** The app's settings.traces (recordDbText, maxSpansPerTrace...), so a worker records what the main thread would. */
  traceSettings?: TraceSettings;
}
export type TaskResponse = { ok: true; output: unknown; spans?: unknown[] } | {
  ok: false;
  message: string;
  /** What the task recorded before failing. */
  spans?: unknown[];
};
