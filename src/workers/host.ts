/// <reference lib="deno.worker" />
/**
 * The Worker every task runs in: imports the task module, calls its default export with the input and posts back
 * the result (buffers transferred, not copied). One task per worker, one worker per job, off the main thread.
 */
import { TaskFailed, traceInWorker } from "../telemetry/instrument/worker.ts";
import type { TaskRequest, TaskResponse } from "./types.ts";

function transferables(v: unknown): Transferable[] {
  if (v instanceof Uint8Array) return [v.buffer as ArrayBuffer];
  return [];
}

self.onmessage = async (e: MessageEvent<TaskRequest>) => {
  try {
    const task = await import(e.data.module);
    const { output, spans } = await traceInWorker(
      e.data.traceparent,
      e.data.traceSettings,
      e.data.module,
      () => task.default(e.data.input),
    );
    self.postMessage({ ok: true, output, spans } satisfies TaskResponse, transferables(output));
  } catch (err) {
    const spans = err instanceof TaskFailed ? err.spans : undefined;
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ ok: false, message, spans } satisfies TaskResponse);
  }
};
