import { assert, assertEquals, assertMatch } from "@std/assert";
import { connect, fixture, structured } from "./testkit.ts";

Deno.test("protocol: tools/call with invalid input is a tool error naming the field", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const r = await c.callTool({ name: "db_list", arguments: { collection: "mt_notas", perPage: 5000 } });
  assert(r.isError);
  assertMatch(JSON.stringify(r.content), /perPage/);
  const missing = await c.callTool({ name: "db_get", arguments: { collection: "mt_notas" } });
  assert(missing.isError);
  assertMatch(JSON.stringify(missing.content), /id/);
  await c.close();
});

Deno.test("protocol: tools/list carries the JSON Schema of the zod input and the annotations", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.suToken);
  const tools = (await c.listTools()).tools;
  const list = tools.find((x) => x.name === "db_list")!;
  assertEquals(list.inputSchema.type, "object");
  assertEquals(list.inputSchema.required, ["collection"]);
  assertEquals((list.inputSchema.properties as Record<string, { maximum?: number }>).perPage.maximum, 200);
  assertEquals(list.annotations?.readOnlyHint, true);
  const del = tools.find((x) => x.name === "db_delete")!;
  assertEquals(del.annotations?.destructiveHint, true);
  await c.close();
});

Deno.test("protocol: resources/read of a record template reads as the caller", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const own = await c.readResource({ uri: `record://mt_notas/${t.notaAna.id}` });
  const content = own.contents[0] as { text: string; mimeType?: string };
  assertEquals(content.mimeType, "application/json");
  assertEquals(JSON.parse(content.text).titulo, "da ana");
  const other = await c.readResource({ uri: `record://mt_notas/${t.notaBia.id}` }).catch((e) => e);
  assert(other instanceof Error);
  await c.close();
});

Deno.test("protocol: resources/list includes the static resources and the templates' listings", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const uris = (await c.listResources()).resources.map((r) => r.uri);
  assert(uris.includes("schema://collections"));
  assert(uris.includes("schema://collections/mt_notas"));
  const templates = (await c.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
  assert(templates.includes("record://{collection}/{id}"));
  await c.close();
});

Deno.test("protocol: prompts/get renders with the args; a missing required arg is an error", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const p = await c.getPrompt({ name: "explorar-collection", arguments: { collection: "mt_notas" } });
  assertEquals(p.messages[0].role, "user");
  assertMatch((p.messages[0].content as { text: string }).text, /schema:\/\/collections\/mt_notas/);
  const bad = await c.getPrompt({ name: "explorar-collection", arguments: {} }).catch((e) => e);
  assert(bad instanceof Error);
  await c.close();
});

Deno.test("protocol: a result over maxResultBytes is an isError with a paging hint, text and structured alike", async () => {
  const t = await fixture({ mcp: { maxResultBytes: 64 } });
  const c = await connect(t.app, t.suToken);
  const r = await c.callTool({ name: "db_list", arguments: { collection: "mt_notas" } });
  assert(r.isError);
  assertEquals(structured(r).code, "resultado_truncado");
  assertEquals(JSON.parse((r.content as { text: string }[])[0].text), r.structuredContent);
  await c.close();
});

Deno.test("protocol: a missing resource is resource-not-found with the uri and the stable code", async () => {
  const t = await fixture();
  const c = await connect(t.app, t.anaToken);
  const e = await c.readResource({ uri: `record://mt_notas/${t.notaBia.id}` }).catch((e) => e);
  // The SDK puts resource-not-found on the wire as -32602 (2026-07-28 MUST; -32002 in older revisions).
  assertEquals(e.code, -32602);
  assertEquals(e.data.uri, `record://mt_notas/${t.notaBia.id}`);
  assertEquals(e.data.status, 404);
  assertEquals(e.data.code, "nao_encontrado");
  await c.close();
});
