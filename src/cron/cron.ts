import { Schedule } from "./schedule.ts";
import { runTask } from "../workers/mod.ts";
import type { Tracer } from "../telemetry/tracer.ts";
import { type CronTrigger, traceCronRun } from "../telemetry/instrument/cron.ts";
import type { JobRunner, JobSpec } from "../jobs/runner.ts";

export type { CronTrigger };

export interface Job {
  readonly id: string;
  readonly expression: string;
  /** One run, scheduled or by hand (the admin's "run now"); skipped, and logged, while the previous one still runs. */
  run(trigger?: CronTrigger): Promise<void>;
  /** Whether a run is in progress. */
  readonly running: boolean;
}

interface Entry {
  id: string;
  expression: string;
  schedule: Schedule;
  fn: () => unknown;
}

/** PB cron.Cron: jobs by id (re-adding replaces), ticking at every minute start once started. */
export class Cron {
  readonly #jobs = new Map<string, Entry>();
  readonly #running = new Set<string>();
  #timer?: ReturnType<typeof setTimeout>;
  #runner?: JobRunner;

  /**
   * `timeZone` is read at every tick, so a settings change applies from the next minute. With a tracer, every run is
   * a trace of its own (`cron <id>`).
   */
  constructor(readonly timeZone: () => string = () => "UTC", readonly tracer?: Tracer) {}

  /** The worker that runs addJob jobs (app.jobs). */
  useRunner(runner: JobRunner): void {
    this.#runner = runner;
  }

  /**
   * A job run on the main thread. Only for work that is not the app's (tests, a db with no file): every job of the
   * app goes through addJob, so it runs in the job worker. Throws on an invalid expression, like PB's Add.
   */
  add(id: string, expression: string, fn: () => unknown): void {
    this.#jobs.set(id, { id, expression, schedule: new Schedule(expression), fn });
  }

  /**
   * A job run in the job worker (app.jobs): by default the job a bootstrap module defined with the same id
   * (defineJob), else `spec`. `input` is computed at each run, so it can carry current settings.
   */
  addJob(id: string, expression: string, spec: JobSpec = { job: id }, input: () => unknown = () => undefined): void {
    this.add(id, expression, () => {
      if (!this.#runner) throw new Error(`cron ${id}: no job runner`);
      return this.#runner.run(spec, input());
    });
  }

  /**
   * A job whose every run is `module`'s default export in a fresh worker of its own (see workers/). Prefer addJob;
   * this stays for tasks that must be killable on their own.
   */
  addTask(id: string, expression: string, module: URL, input: () => unknown = () => undefined): void {
    this.add(id, expression, () => runTask(module, input()));
  }

  remove(id: string): void {
    this.#jobs.delete(id);
  }

  /** PB cronsList order: by id, system jobs last (PB's "__pb", and denobase's own "__denobase"). */
  jobs(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => {
      const sa = a.id.startsWith("__"), sb = b.id.startsWith("__");
      return sa !== sb ? (sa ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }).map((e) => this.#job(e));
  }

  get(id: string): Job | undefined {
    const e = this.#jobs.get(id);
    return e && this.#job(e);
  }

  #job(e: Entry): Job {
    const running = this.#running;
    return {
      id: e.id,
      expression: e.expression,
      run: (trigger = "schedule") => this.#run(e, trigger),
      get running() {
        return running.has(e.id);
      },
    };
  }

  /** No overlap: a run that finds the previous one still going is skipped, so a slow job never piles up. */
  async #run(e: Entry, trigger: CronTrigger): Promise<void> {
    if (this.#running.has(e.id)) {
      console.warn(`cron ${e.id}: skipped (${trigger}), the previous run is still going`);
      return;
    }
    this.#running.add(e.id);
    try {
      await traceCronRun(this.tracer, e.id, e.fn, { schedule: e.expression, trigger });
    } catch (err) {
      console.error(`cron ${e.id} failed`, err);
    } finally {
      this.#running.delete(e.id);
    }
  }

  /** Runs every job due at `now`; the ticker calls it, tests call it with a pinned date. */
  tick(now: Date = new Date()): Promise<void[]> {
    const tz = this.timeZone();
    return Promise.all(
      [...this.#jobs.values()].filter((j) => j.schedule.isDue(now, tz)).map((j) => this.#run(j, "schedule")),
    );
  }

  start(): void {
    if (this.#timer !== undefined) return;
    const schedule = () => {
      const now = Date.now();
      this.#timer = setTimeout(() => {
        void this.tick(new Date());
        schedule();
      }, 60_000 - (now % 60_000) + 5);
    };
    schedule();
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
