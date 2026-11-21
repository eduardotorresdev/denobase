/**
 * The generic executor entry (§16 N1): what a supervisor launches when the app was not started through createCli
 * (createApp({ setup }) directly, `deno test` with a file db). `--setup <url>` names the module that sets the app up.
 */
import { parseArgs } from "../cli/engine.ts";
import { EXECUTOR_ENV } from "./launch.ts";
import { runExecutor } from "./executor.ts";
import type { ExecutorArgs } from "./protocol.ts";

if (import.meta.main) {
  if (!Deno.env.get(EXECUTOR_ENV)) {
    console.error("executor_main.ts is internal: a supervisor launches it");
    Deno.exit(2);
  }
  Deno.exit(await runExecutor(executorArgsFrom(parseArgs(Deno.args).flags)));
}

export function executorArgsFrom(f: Record<string, string | true>): ExecutorArgs {
  const s = (k: string) => (typeof f[k] === "string" ? f[k] as string : undefined);
  const kind = s("kind");
  if (kind !== "normal" && kind !== "heavy" && kind !== "list") throw new Error(`executor: bad --kind ${kind}`);
  const db = s("db"), aux = s("aux");
  if (!db || !aux) throw new Error("executor: --db and --aux are required");
  return { kind, db, aux, storage: s("storage"), dataDir: s("data-dir"), setup: s("setup") };
}
