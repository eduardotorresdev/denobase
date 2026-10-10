import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { z } from "zod";
import { stableForbidden } from "../core/errors.ts";
import { connect, fixture, structured } from "./testkit.ts";

Deno.test("extension: a consumer tool appears in tools/list and runs as the caller with ctx.store", async () => {
  const t = await fixture();
  t.app.mcp.tool({
    name: "pbs_minhas_notas",
    description: "Count my notes.",
    input: z.object({ prefixo: z.string().optional() }),
    output: z.object({ total: z.number(), quem: z.string() }),
    annotations: { readOnly: true },
    handler: async (a, ctx) => {
      const notas = await ctx.store.collection("mt_notas").find();
      return {
        total: notas.filter((n) => String(n.titulo).startsWith(a.prefixo ?? "")).length,
        quem: ctx.user?.id ?? "",
      };
    },
  });
  const c = await connect(t.app, t.anaToken);
  const tool = (await c.listTools()).tools.find((x) => x.name === "pbs_minhas_notas");
  assert(tool);
  assertEquals(tool.outputSchema?.type, "object");
  const r = await c.callTool({ name: "pbs_minhas_notas", arguments: { prefixo: "da" } });
  assertEquals(r.structuredContent, { total: 1, quem: t.ana.id });
  await c.close();
});

Deno.test("extension: a thrown stable error becomes isError with its code; visibility and allow() hide tools", async () => {
  const t = await fixture();
  t.app.mcp.tool({
    name: "pbs_recusa",
    description: "Always refuses.",
    input: z.object({}),
    handler: () => Promise.reject(stableForbidden("Nao pode.", "lote_bloqueado")),
  });
  t.app.mcp.tool({
    name: "pbs_so_bia",
    description: "Only Bia sees it.",
    input: z.object({}),
    allow: (ctx) => ctx.user?.id === t.bia.id,
    handler: () => Promise.resolve({ ok: true }),
  });
  t.app.mcp.tool({
    name: "pbs_admin",
    description: "Superuser only.",
    visibility: "superuser",
    input: z.object({}),
    handler: (_a, ctx) => Promise.resolve({ system: !!ctx.system }),
  });
  const ana = await connect(t.app, t.anaToken);
  const r = await ana.callTool({ name: "pbs_recusa", arguments: {} });
  assert(r.isError);
  assertEquals(structured(r).code, "lote_bloqueado");
  const names = (await ana.listTools()).tools.map((x) => x.name);
  assertFalse(names.includes("pbs_so_bia"));
  assertFalse(names.includes("pbs_admin"));
  await ana.close();
  const bia = await connect(t.app, t.biaToken);
  assert((await bia.listTools()).tools.some((x) => x.name === "pbs_so_bia"));
  await bia.close();
  const su = await connect(t.app, t.suToken);
  assertEquals((await su.callTool({ name: "pbs_admin", arguments: {} })).structuredContent, { system: true });
  await su.close();
});

Deno.test("extension: resources, templates and prompts registered by the consumer are served", async () => {
  const t = await fixture();
  t.app.mcp.resource({
    uri: "pbs://docs/index",
    name: "docs_index",
    mimeType: "text/markdown",
    read: () => Promise.resolve("# Docs"),
  });
  t.app.mcp.resourceTemplate({
    name: "pbs_doc",
    uriTemplate: "pbs://docs/{path}",
    mimeType: "text/markdown",
    read: (_u, v) => Promise.resolve(`doc ${v.path}`),
  });
  t.app.mcp.prompt({
    name: "gerar-relatorio",
    description: "Report.",
    args: z.object({ tema: z.string() }),
    render: (a) => `Relatorio sobre ${a.tema}`,
  });
  const c = await connect(t.app, t.anaToken);
  assertEquals(((await c.readResource({ uri: "pbs://docs/index" })).contents[0] as { text: string }).text, "# Docs");
  assertEquals(((await c.readResource({ uri: "pbs://docs/adr" })).contents[0] as { text: string }).text, "doc adr");
  const p = await c.getPrompt({ name: "gerar-relatorio", arguments: { tema: "lotes" } });
  assertEquals((p.messages[0].content as { text: string }).text, "Relatorio sobre lotes");
  await c.close();
});

Deno.test("extension: names are validated, duplicates refused, unregister removes, list() is sorted", async () => {
  const t = await fixture();
  const def = { description: "x", input: z.object({}), handler: () => Promise.resolve(1) };
  assertThrows(() => t.app.mcp.tool({ ...def, name: "Bad-Name" }), Error, "invalid tool name");
  assertThrows(() => t.app.mcp.tool({ ...def, name: "db_list" }), Error, "duplicate tool");
  const off = t.app.mcp.tool({ ...def, name: "aaa_first" });
  assertEquals(t.app.mcp.list().tools[0], "aaa_first");
  off();
  assertFalse(t.app.mcp.list().tools.includes("aaa_first"));
  // A stale unregister does not remove a later registration under the same name.
  const again = t.app.mcp.tool({ ...def, name: "aaa_first" });
  off();
  assert(t.app.mcp.list().tools.includes("aaa_first"));
  again();
});

Deno.test("extension: registering after connect notifies tools/list_changed to a listening 2026 client", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken, "modern");
  const changed = Promise.withResolvers<void>();
  c.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
  const sub = await c.listen({ toolsListChanged: true });
  const off = t.app.mcp.tool({
    name: "pbs_tardia",
    description: "Registered late.",
    input: z.object({}),
    handler: () => Promise.resolve({ ok: true }),
  });
  await changed.promise;
  assert((await c.listTools()).tools.some((x) => x.name === "pbs_tardia"));
  assertEquals((await c.callTool({ name: "pbs_tardia", arguments: {} })).structuredContent, { ok: true });
  off();
  await sub.close();
  await c.close();
  await t.app.terminate();
});

Deno.test("extension: useTracer wraps calls in spans and registers the traces tool when it can query", async () => {
  const t = await fixture();
  const spans: string[] = [];
  t.app.mcp.useTracer({
    span: (name, _attrs, fn) => (spans.push(name), fn()),
    query: ({ limit }) => Promise.resolve({ items: [], limit }),
  });
  const c = await connect(t.app, t.suToken);
  const r = await c.callTool({ name: "db_traces", arguments: { limit: 5 } });
  assertEquals(r.structuredContent, { items: [], limit: 5 });
  assertEquals(spans, ["mcp.tool db_traces"]);
  await c.close();
});

Deno.test("extension: an async allow() decides tools/list per principal", async () => {
  const t = await fixture();
  t.app.mcp.tool({
    name: "pbs_async",
    description: "Visible to whoever owns a note titled 'da bia'.",
    input: z.object({}),
    allow: async (ctx) => (await ctx.store.collection("mt_notas").find()).some((n) => n.titulo === "da bia"),
    handler: () => Promise.resolve({ ok: true }),
  });
  const ana = await connect(t.app, t.anaToken);
  assertFalse((await ana.listTools()).tools.some((x) => x.name === "pbs_async"));
  await ana.close();
  const bia = await connect(t.app, t.biaToken);
  assert((await bia.listTools()).tools.some((x) => x.name === "pbs_async"));
  await bia.close();
});

Deno.test("extension: a group prefixes every name, refuses the built-ins' prefix and comes off at once", async () => {
  const t = await fixture();
  assertThrows(() => t.app.mcp.group("db_"), Error, "built-ins");
  assertThrows(() => t.app.mcp.group("Pbs"), Error, "invalid group prefix");
  const g = t.app.mcp.group("pbs_");
  g.tool({ name: "eco", description: "Echo.", input: z.object({}), handler: () => Promise.resolve({ ok: true }) });
  g.resource({ uri: "pbs://g", name: "g", read: () => Promise.resolve("g") });
  g.prompt({ name: "p", description: "P.", render: () => "p" });
  const l = t.app.mcp.list();
  assert(l.tools.includes("pbs_eco"));
  assert(l.prompts.includes("pbs_p"));
  g.off();
  const after = t.app.mcp.list();
  assertFalse(
    after.tools.includes("pbs_eco") || after.prompts.includes("pbs_p") || after.resources.includes("pbs://g"),
  );
});

Deno.test("extension: one naming rule for every kind; resource names are listed and unique", async () => {
  const t = await fixture();
  const read = () => Promise.resolve("x");
  assertThrows(() => t.app.mcp.resource({ uri: "x://a", name: "Bad Name", read }), Error, "invalid resource name");
  t.app.mcp.resource({ uri: "x://a", name: "x_a", read });
  assertThrows(() => t.app.mcp.resource({ uri: "x://b", name: "x_a", read }), Error, "duplicate resource name");
  assertThrows(
    () => t.app.mcp.resourceTemplate({ uriTemplate: "x://{id}", name: "x_a", read }),
    Error,
    "duplicate resource name",
  );
  const c = await connect(t.app, t.anaToken);
  const r = (await c.listResources()).resources.find((x) => x.uri === "x://a");
  assertEquals(r?.name, "x_a");
  await c.close();
});

Deno.test("extension: a tool with an output schema that returns a non-object is an isError, not a bad result", async () => {
  const t = await fixture();
  t.app.mcp.tool({
    name: "pbs_lista",
    description: "Wrong shape.",
    input: z.object({}),
    output: z.object({ items: z.array(z.number()) }),
    handler: () => Promise.resolve([1, 2] as never),
  });
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({ name: "pbs_lista", arguments: {} });
  assert(r.isError);
  assertEquals(structured(r).code, "erro_interno");
  await c.close();
});
