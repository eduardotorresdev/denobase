import { type ExecutorArgs, executorArgv } from "./protocol.ts";

/**
 * How a supervisor starts an executor (§16 N1, §17). The executor is the consumer's own program relaunched with the
 * hidden `__executor` command, so JSR, the import map, the lock and a compiled binary resolve as in the parent; the
 * child's flags are configured, never derived (Deno does not expose the parent's). Without the CLI (createApp with a
 * setup, `deno test`) it is denobase's generic entry, src/queue/executor_main.ts, given the setup URL.
 */
export interface Launch {
  /** argv before the executor's own args: [cmd, ...prefix]. */
  cmd: string;
  prefix: string[];
  env: Record<string, string>;
}

export const EXECUTOR_ENV = "DENOBASE_EXECUTOR";
export const EXECUTOR_COMMAND = "__executor";
export const DEFAULT_EXECUTOR_FLAGS = ["-A"];

/** The flags a child gets: createCli({ executorFlags }), else DENOBASE_EXECUTOR_FLAGS (space separated), else -A. */
export function executorFlags(configured?: string[]): string[] {
  if (configured) return configured;
  const env = Deno.env.get("DENOBASE_EXECUTOR_FLAGS")?.trim();
  return env ? env.split(/\s+/) : DEFAULT_EXECUTOR_FLAGS;
}

/** Set by createCli's run: the program can relaunch itself as an executor. */
let cliEntry: { flags: string[] } | null = null;
export function markCliEntry(flags?: string[]): void {
  cliEntry = { flags: executorFlags(flags) };
}

export class ExecutorUnavailable extends Error {
  readonly code = "executor_unavailable";
}

/**
 * The launch for this process, or why there is none: a compiled binary only relaunches itself through createCli;
 * without `--allow-run` on Deno.execPath() nothing can be launched.
 */
export function resolveLaunch(setup: string | undefined, flags?: string[]): Launch {
  const exec = Deno.execPath();
  const env = { [EXECUTOR_ENV]: String(Deno.pid) };
  const standalone = (Deno.build as { standalone?: boolean }).standalone === true;
  let launch: Launch;
  if (cliEntry) {
    launch = standalone
      ? { cmd: exec, prefix: [EXECUTOR_COMMAND], env }
      : { cmd: exec, prefix: ["run", ...cliEntry.flags, Deno.mainModule, EXECUTOR_COMMAND], env };
  } else {
    if (standalone) {
      throw new ExecutorUnavailable("compiled binaries launch executors through createCli");
    }
    if (!setup) throw new ExecutorUnavailable("no setup module: executors cannot know the app's jobs");
    const main = new URL("./executor_main.ts", import.meta.url).href;
    launch = { cmd: exec, prefix: ["run", ...executorFlags(flags), main], env };
  }
  const perm = Deno.permissions.querySync({ name: "run", command: exec });
  if (perm.state !== "granted") {
    throw new ExecutorUnavailable(`no permission to launch executors (--allow-run must cover ${exec})`);
  }
  return launch;
}

export function argvFor(l: Launch, a: ExecutorArgs): string[] {
  return [...l.prefix, ...executorArgv(a)];
}
