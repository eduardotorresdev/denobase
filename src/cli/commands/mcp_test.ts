import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openDb } from "../../core/db.ts";
import { superusers } from "../../core/superusers.ts";
import { dbWith } from "../../testing/mod.ts";

const MOD = new URL("../../../mod.ts", import.meta.url).href;
const CONFIG = new URL("../../../deno.json", import.meta.url).pathname;

/** The real `mcp` command in a child process: stdout must carry only the protocol. */
async function session(dir: string, args: string[]) {
  const script = `${dir}/cli.ts`;
  await Deno.writeTextFile(
    script,
    `import { createCli } from ${JSON.stringify(MOD)};\nDeno.exit(await createCli().run(Deno.args));\n`,
  );
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: ["run", "-A", "--quiet", "--config", CONFIG, script, "mcp", "--db", `${dir}/pb_data/data.db`, ...args],
    env: { ...Deno.env.toObject(), DENOBASE_UI: "off" },
    stderr: "pipe",
  });
  const client = new Client({ name: "cli", version: "1" });
  await client.connect(transport);
  return client;
}

Deno.test({
  name: "cli mcp: stdio session, superuser by default and as --as <email>",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/pb_data`);
      const db = await dbWith([superusers], openDb(`${dir}/pb_data/data.db`));
      db.close();
      const root = await session(dir, []);
      const tools = (await root.listTools()).tools.map((t) => t.name);
      assert(tools.includes("db_sql"));
      const h = await root.callTool({ name: "db_health", arguments: {} });
      assertEquals((h.structuredContent as { transport: string }).transport, "stdio");
      await root.callTool({
        name: "db_create",
        arguments: {
          collection: "_superusers",
          data: { email: "a@x.io", password: "12345678", passwordConfirm: "12345678" },
        },
      });
      await root.close();
      const as = await session(dir, ["--as", "a@x.io"]);
      const who = await as.callTool({ name: "db_health", arguments: {} });
      assertEquals((who.structuredContent as { auth: { collection: string } }).auth.collection, "_superusers");
      await as.close();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
