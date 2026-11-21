import type { Command } from "../engine.ts";
import { EXECUTOR_COMMAND, EXECUTOR_ENV } from "../../queue/launch.ts";
import { runExecutor } from "../../queue/executor.ts";
import { executorArgsFrom } from "../../queue/executor_main.ts";
import type { ServeOptions } from "./serve.ts";

/**
 * `__executor` (hidden, internal): the program relaunched by a supervisor to run jobs (§16 N1). Refused without the
 * env a supervisor sets, and that env refuses every other command (Cli.run): no launch chain.
 */
export function executorCommand(opts: ServeOptions = {}): Command {
  return {
    name: EXECUTOR_COMMAND,
    hidden: true,
    run: async (c) => {
      if (!Deno.env.get(EXECUTOR_ENV)) {
        console.error(`${EXECUTOR_COMMAND} is internal: a supervisor launches it`);
        return 2;
      }
      // Exits at once: stdin and the parent watch keep the loop alive after the last job (R4).
      Deno.exit(await runExecutor(executorArgsFrom(c.flags), opts.setup));
    },
  };
}
