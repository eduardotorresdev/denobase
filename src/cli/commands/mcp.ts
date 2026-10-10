import process from "node:process";
import { FsStorage } from "../../files/storage.ts";
import { openDb } from "../../core/db.ts";
import { type Command, UsageError } from "../engine.ts";
import { createApp } from "../../app.ts";
import { dataDirOf, DEFAULT_DB, openFileDb } from "../data.ts";
import { principalByEmail, serveMcpStdio, STDIO_SUPERUSER } from "../../mcp/stdio.ts";
import type { ServeOptions } from "./serve.ts";

/**
 * `mcp [--db path] [--as email]`: the app's MCP over stdio, for a local client (Claude Code) pointing at the
 * binary. Without --as the session is superuser; the consumer's beforeServe runs so its tools are registered.
 */
export function mcpCommand(opts: ServeOptions = {}): Command {
  return {
    name: "mcp",
    usage: "[--db path] [--as email]",
    description: "serve the MCP server over stdio (superuser unless --as)",
    run: async (c) => {
      // stdout is the protocol channel: anything the app prints goes to stderr.
      console.log = console.error;
      console.info = console.error;
      const dbPath = c.str("db") ?? Deno.env.get("DB_PATH") ?? DEFAULT_DB;
      const own = dataDirOf(dbPath);
      const app = createApp({
        db: openFileDb(dbPath),
        settings: opts.settings,
        mcp: opts.mcp,
        storage: new FsStorage(`${own ?? "."}/storage`),
        auxDb: openDb(`${own ?? "."}/auxiliary.db`),
        dataDir: own ?? undefined,
        adminUiDir: false,
      });
      await opts.beforeServe?.(app);
      const email = c.str("as");
      const user = email ? await principalByEmail(app, email) : STDIO_SUPERUSER;
      if (!user) throw new UsageError(`--as: no auth record with email ${email}`);
      const handle = serveMcpStdio(app, user);
      const closed = Promise.withResolvers<void>();
      // The client closing stdin ends the session; an extra listener does not steal the transport's data.
      process.stdin.once("end", () => closed.resolve());
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        if (Deno.build.os !== "windows" || sig === "SIGINT") Deno.addSignalListener(sig, () => closed.resolve());
      }
      await closed.promise;
      await handle.close();
      await app.terminate();
    },
  };
}
