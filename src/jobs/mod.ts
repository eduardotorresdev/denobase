/** Jobs and backups off the main thread: the job worker writes directly, the main thread owns the singletons. */
export { defineJob, type JobBootstrap, type JobContext, type JobFn, type JobTask } from "./context.ts";
export { currentJob, inJobWorker, onMain } from "./on_main.ts";
export { JobRunner, type JobSpec } from "./runner.ts";
