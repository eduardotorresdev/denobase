import { SpanKind } from "../span.ts";
import { runInSpan, type Tracer } from "../tracer.ts";

export type CronTrigger = "schedule" | "manual";

/**
 * Each cron run is a trace of its own: root `cron <id>`, kind internal, always kept whatever the head sampling says
 * (a job runs a few times an hour, and its trace is how a freeze or a drift is explained). The job worker's spans and
 * the batches applied on the main thread hang under it.
 */
export function traceCronRun(
  tracer: Tracer | undefined,
  id: string,
  fn: () => unknown,
  info: { schedule?: string; trigger?: CronTrigger } = {},
): Promise<unknown> {
  if (!tracer) return Promise.resolve().then(fn);
  return runInSpan(
    tracer.startRoot(`cron ${id}`, {
      kind: SpanKind.internal,
      keep: true,
      attributes: {
        "cron.job.id": id,
        "cron.name": id,
        "cron.schedule": info.schedule,
        "cron.trigger": info.trigger ?? "schedule",
        thread: "main",
      },
    }),
    fn,
  );
}
