import { assert, assertEquals } from "@std/assert";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { fixture, structured } from "./testkit.ts";
import { principalByEmail, serveMcpStdio, STDIO_SUPERUSER } from "./stdio.ts";

Deno.test("e2e: the SDK client over a real socket on a free port, as a user, with a consumer tool", async () => {
  const t = await fixture();
  t.app.mcp.tool({
    name: "pbs_eco",
    description: "Echo.",
    input: z.object({ msg: z.string() }),
    handler: (a, ctx) => Promise.resolve({ msg: a.msg, user: ctx.user?.id }),
  });
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, t.app.fetch);
  try {
    const url = new URL(`http://127.0.0.1:${server.addr.port}/api/mcp`);
    for (const mode of ["legacy", "modern"] as const) {
      const client = new Client(
        { name: "e2e", version: "1" },
        mode === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined,
      );
      await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${t.anaToken}` } } }),
      );
      const r = await client.callTool({ name: "pbs_eco", arguments: { msg: "oi" } });
      assertEquals(r.structuredContent, { msg: "oi", user: t.ana.id }, mode);
      const list = structured(await client.callTool({ name: "db_list", arguments: { collection: "mt_notas" } }));
      assertEquals((list.items as { titulo: string }[]).map((i) => i.titulo), ["da ana"], mode);
      await client.close();
    }
  } finally {
    await t.app.terminate();
    await server.shutdown();
  }
});

async function stdioClient(t: Awaited<ReturnType<typeof fixture>>, user: Parameters<typeof serveMcpStdio>[1]) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveMcpStdio(t.app, user, { transport: serverSide });
  const client = new Client({ name: "stdio", version: "1" });
  await client.connect(clientSide);
  return { client, close: async () => (await client.close(), await handle.close()) };
}

Deno.test("stdio: without --as the session is superuser and sees the admin tools", async () => {
  const t = await fixture();
  const s = await stdioClient(t, STDIO_SUPERUSER);
  const tools = (await s.client.listTools()).tools.map((x) => x.name);
  assert(tools.includes("db_sql"));
  const h = structured(await s.client.callTool({ name: "db_health", arguments: {} }));
  assertEquals(h.transport, "stdio");
  await s.close();
});

Deno.test("stdio: --as runs as that record, with its access rules", async () => {
  const t = await fixture();
  const ana = await principalByEmail(t.app, "ana@x.io");
  assertEquals(ana?.collection, "mt_users");
  assertEquals(await principalByEmail(t.app, "ninguem@x.io"), null);
  const s = await stdioClient(t, ana);
  const tools = (await s.client.listTools()).tools.map((x) => x.name);
  assert(!tools.includes("db_sql"));
  const list = structured(await s.client.callTool({ name: "db_list", arguments: { collection: "mt_notas" } }));
  assertEquals((list.items as { titulo: string }[]).map((i) => i.titulo), ["da ana"]);
  await s.close();
});

Deno.test("stdio: a tool registered after connect reaches the client as list_changed and is callable", async () => {
  const t = await fixture();
  const s = await stdioClient(t, STDIO_SUPERUSER);
  const changed = Promise.withResolvers<void>();
  s.client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
  const off = t.app.mcp.tool({
    name: "pbs_tardia",
    description: "Registered late.",
    input: z.object({}),
    handler: () => Promise.resolve({ ok: true }),
  });
  await changed.promise;
  assert((await s.client.listTools()).tools.some((x) => x.name === "pbs_tardia"));
  assertEquals((await s.client.callTool({ name: "pbs_tardia", arguments: {} })).structuredContent, { ok: true });
  off();
  await s.close();
});
