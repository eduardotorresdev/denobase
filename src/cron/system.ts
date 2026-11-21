import type { Settings } from "../settings/mod.ts";
import type { Queue } from "../queue/queue.ts";
import { cleanupNodes } from "../queue/nodes.ts";
import { maintain, type MaintenanceJob } from "./tasks/maintenance.ts";

/**
 * PB's own maintenance jobs, and ours: old logs and traces, db optimize, expired OTPs and OAuth rows, the queue's
 * retention. Each is a normal job of the queue under its PB id, scheduled under the same id. The WAL checkpoints are
 * not jobs: the serve's scheduler runs them itself (§5), so they keep the WAL bounded with no worker alive.
 */
const JOBS: [string, string, MaintenanceJob][] = [
  ["__pbLogsCleanup__", "0 */6 * * *", "logsCleanup"],
  ["__denobaseTracesCleanup__", "0 * * * *", "tracesCleanup"],
  ["__pbDBOptimize__", "0 0 * * *", "dbOptimize"],
  ["__pbOTPCleanup__", "0 * * * *", "otpCleanup"],
  ["__denobaseOAuthCleanup__", "30 * * * *", "oauthCleanup"],
];

export const QUEUE_CLEANUP = "__denobaseQueueCleanup__";

export function systemJobs(queue: Queue, _settings: Settings): void {
  for (const [id, expr, job] of JOBS) {
    queue.define(id, async (ctx) => {
      // The setting is read at each run: a change applies from the next one.
      const maxDays = job === "tracesCleanup" ? ctx.settings.traces.maxDays : ctx.settings.logs.maxDays;
      await ctx.fence();
      await maintain(
        { job, dbPath: "", auxPath: "", maxDays },
        () => ctx.internalDb("data"),
        () => ctx.internalDb("aux"),
      );
    }, { maxAttempts: 1 });
    queue.schedule(id, expr, id);
  }
  queue.define(QUEUE_CLEANUP, async (ctx) => {
    await ctx.fence();
    const removed = await ctx.app.queue.cleanup();
    cleanupNodes(ctx.internalDb("aux"), Date.now());
    ctx.record({ "queue.removed": removed });
  }, { maxAttempts: 1 });
  queue.schedule(QUEUE_CLEANUP, "15 * * * *", QUEUE_CLEANUP);
}
