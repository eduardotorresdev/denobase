import { assertEquals } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { dbWith } from "../testing/mod.ts";

const bt_itens = defineCollection({
  slug: "bt_itens",
  fields: [{ name: "nome", type: "text", required: true, unique: true }],
  access: { read: () => true, create: () => true, update: () => true, delete: () => true },
});
registerCollections(bt_itens);

async function setup(enabled = true) {
  const db = await dbWith([bt_itens]);
  const app = createApp({ db, mailer: new MemoryMailer(), settings: { batch: { enabled } } });
  const post = async (path: string, body: unknown) => {
    const res = await app.http.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const names = async () => (await app.store.collection(bt_itens).query().orderBy("nome").all()).map((r) => r.nome);
  return { app, post, names };
}

const URL = "/api/collections/bt_itens/records";

Deno.test("batch is off by default, like PB's settings", async () => {
  const t = await setup(false);
  const r = await t.post("/api/batch", { requests: [] });
  assertEquals([r.status, r.body.message], [403, "Batch requests are not allowed."]);
});

Deno.test("batch runs create, upsert, update and delete in order and answers [{body, status}]", async () => {
  const t = await setup();
  const keep = await t.app.store.collection(bt_itens).create({ nome: "velho" });
  const r = await t.post("/api/batch", {
    requests: [
      { method: "POST", url: `${URL}?fields=nome`, body: { nome: "a" } },
      { method: "PUT", url: URL, body: { id: keep.id, nome: "velho2" } },
      { method: "PUT", url: URL, body: { id: "novoid000000001", nome: "b" } },
      { method: "DELETE", url: `${URL}/${keep.id}` },
    ],
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.map((x: { status: number }) => x.status), [200, 200, 200, 204]);
  assertEquals(r.body[0], { body: { nome: "a" }, status: 200 });
  assertEquals([r.body[1].body.nome, r.body[2].body.id, r.body[3].body], ["velho2", "novoid000000001", null]);
  assertEquals(await t.names(), ["a", "b"]);
});

Deno.test("a failing sub-request rolls the whole batch back and is reported under requests.<i>", async () => {
  const t = await setup();
  const r = await t.post("/api/batch", {
    requests: [
      { method: "POST", url: URL, body: { nome: "a" } },
      { method: "POST", url: URL, body: { nome: "a" } },
    ],
  });
  assertEquals(r.status, 400);
  assertEquals(r.body.message, "Batch transaction failed.");
  assertEquals(r.body.data.requests["1"], {
    code: "batch_request_failed",
    message: "Batch request failed.",
    response: {
      status: 400,
      message: "Failed to create record.",
      data: { nome: { code: "validation_not_unique", message: "Value must be unique." } },
    },
  });
  assertEquals(await t.names(), []);
});

Deno.test("batch rejects an empty list and actions outside record writes", async () => {
  const t = await setup();
  const empty = await t.post("/api/batch", { requests: [] });
  assertEquals([empty.status, empty.body.message, empty.body.data.requests.code], [
    400,
    "Invalid batch request data.",
    "validation_required",
  ]);
  const bad = await t.post("/api/batch", { requests: [{ method: "GET", url: URL }] });
  assertEquals([bad.status, bad.body.data.requests["0"].code], [400, "batch_request_failed"]);
});

Deno.test("a client may pick a 15-char [a-z0-9] id on create; anything else is a field error", async () => {
  const t = await setup();
  const ok = await t.post(URL, { id: "abcdefghij12345", nome: "x" });
  assertEquals([ok.status, ok.body.id], [200, "abcdefghij12345"]);
  const short = await t.post(URL, { id: "abc", nome: "y" });
  assertEquals(short.body.data.id.code, "validation_min_text_constraint");
  const upper = await t.post(URL, { id: "ABCDEFGHIJ12345", nome: "y" });
  assertEquals(upper.body.data.id.code, "validation_invalid_format");
  const dup = await t.post(URL, { id: "abcdefghij12345", nome: "z" });
  assertEquals(dup.body.data.id.code, "validation_pk_invalid");
});
