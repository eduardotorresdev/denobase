import { createCli } from "../../cli/mod.ts";

if (import.meta.main) {
  Deno.exit(await createCli({ setup: new URL("./setup.ts", import.meta.url) }).run(Deno.args));
}
