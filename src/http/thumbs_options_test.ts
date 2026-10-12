import { assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { collections, registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { thumbsErrors } from "../core/field_options.ts";
import type { CollectionConfig } from "../core/types.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

Deno.env.set("BCRYPT_COST", "4");

const MATCH = { code: "validation_match_invalid", message: "Must be in a valid format." };
const NOT_IN = { code: "validation_not_in_invalid", message: "Must not be in list." };

Deno.test("thumbs follow PB's ThumbSizeRegex and refuse the 0x0 sizes; empty items pass like ozzo", () => {
  assertEquals(thumbsErrors(undefined), null);
  assertEquals(thumbsErrors(["100x100", "0x30", "30x0", "10x10t", "10x10b", "10x10f", ""]), null);
  assertEquals(thumbsErrors(["10x10", "abc", "0x0", "10x10x", " 10x10", "0x0f", "10X10", "-1x10"]), {
    1: MATCH,
    2: NOT_IN,
    3: MATCH,
    4: MATCH,
    5: NOT_IN,
    6: MATCH,
    7: MATCH,
  });
});

Deno.test("defineCollection and registerCollections refuse invalid thumbs, naming field and size", () => {
  const bad = { slug: "to_bad", fields: [{ name: "img", type: "file", thumbs: ["10x10", "big"] }] };
  assertThrows(
    () => defineCollection(bad as CollectionConfig),
    Error,
    `collection "to_bad": invalid field "img" thumbs: "big" Must be in a valid format.`,
  );
  assertThrows(() => registerCollections(bad as CollectionConfig), Error, "Must be in a valid format.");
  assertEquals(collections.some((c) => c.slug === "to_bad"), false);
  // Fine sizes pass.
  defineCollection({ slug: "to_ok", fields: [{ name: "img", type: "file", thumbs: ["10x10f"] }] });
});

async function setup() {
  const db = await dbWith([superusers]);
  const app = createApp({ db, mailer: new MemoryMailer() });
  const su = await app.store.collection(superusers).create(
    { email: "su@x.io", password: "12345678", passwordConfirm: "12345678" } as never,
  );
  const token = await tokenFor(db, "_superusers", su);
  return async (method: string, path: string, body: unknown) => {
    const r = await app.http.request(path, {
      method,
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
}

const fields = [{ name: "title", type: "text" }, { name: "img", type: "file", thumbs: ["10x10", "0x0", "nope"] }];

Deno.test("collection create/update answer PB's thumbs validation error before the read-only refusal", async () => {
  const send = await setup();
  const create = await send("POST", "/api/collections", { name: "x", type: "base", fields });
  assertEquals(create, {
    status: 400,
    json: {
      status: 400,
      message: "Failed to create collection.",
      data: { fields: { 1: { thumbs: { 1: NOT_IN, 2: MATCH } } } },
    },
  });
  const update = await send("PATCH", "/api/collections/_superusers", { fields });
  assertEquals(update.json.message, "Failed to update collection.");
  assertEquals(update.json.data, { fields: { 1: { thumbs: { 1: NOT_IN, 2: MATCH } } } });
  // Valid thumbs still meet the read-only refusal.
  const ok = await send("POST", "/api/collections", {
    name: "x",
    fields: [{ name: "img", type: "file", thumbs: ["1x1"] }],
  });
  assertEquals(ok.json.message, "Collections are declared in code and cannot be changed through the API.");
});

Deno.test("collection import answers PB's import failure for invalid thumbs", async () => {
  const send = await setup();
  const r = await send("PUT", "/api/collections/import", {
    collections: [{ id: "c1", name: "fine", fields: [] }, { id: "c2", name: "pics", fields }],
  });
  assertEquals(r.status, 400);
  assertEquals(r.json.message, "Failed to import collections.");
  assertEquals(r.json.data.collections.code, "validation_collections_import_failure");
  assertEquals(
    r.json.data.collections.message,
    `Data validations failed for collection "pics" (c2):\n${
      JSON.stringify(
        { fields: { 1: { thumbs: { 1: "must not be in list", 2: "must be in a valid format" } } } },
        null,
        2,
      )
    }.`,
  );
});
