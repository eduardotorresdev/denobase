import { assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { collectSpans, dbWith } from "../testing/mod.ts";
import { PathRedactor } from "./redact_path.ts";

const SECRET = "s3cr3t-0f-the-webhook-that-must-never-be-stored";

Deno.test("redactPath: masks the :param segments of a matching path, prefix included, and leaves others alone", () => {
  const r = new PathRedactor();
  r.add("/api/hooks/:secret");
  assertEquals(r.redact(`/api/hooks/${SECRET}`), "/api/hooks/***");
  // A trailing slash or extra segments are a 404, still logged: the secret must not ride along.
  assertEquals(r.redact(`/api/hooks/${SECRET}/`), "/api/hooks/***/");
  assertEquals(r.redact(`/api/hooks/${SECRET}/x`), "/api/hooks/***/x");
  assertEquals(r.redact("/api/hooks"), "/api/hooks");
  assertEquals(r.redact(`/api/other/${SECRET}`), `/api/other/${SECRET}`);
  assertThrows(() => r.add("/api/hooks"), Error, "no :param");
});

Deno.test("redactPath: the activity log and the request span never store the secret of a registered route", async () => {
  const app = createApp({ db: await dbWith([]), mailer: new MemoryMailer(), adminUiDir: false });
  const collected = collectSpans(app);
  app.redactPath("/api/hooks/:secret");
  app.http.post("/api/hooks/:secret", (c) => c.json({ ok: c.req.param("secret") === SECRET }));
  for (const path of [`/api/hooks/${SECRET}`, `/api/hooks/${SECRET}/x`]) {
    const res = await app.http.request(path, { method: "POST" });
    await res.body?.cancel();
  }
  const lines = app.logs.list({ perPage: 100 }).items;
  assertEquals(lines.map((l) => [l.message, l.data.url]).sort(), [
    ["POST /api/hooks/***", "/api/hooks/***"],
    ["POST /api/hooks/***/x", "/api/hooks/***/x"],
  ]);
  const roots = collected.spans().filter((s) => s.root);
  assertEquals(roots.map((s) => s.attributes["url.path"]).sort(), ["/api/hooks/***", "/api/hooks/***/x"]);
  const everything = JSON.stringify([lines, collected.spans()]);
  assertEquals(everything.includes(SECRET), false);
});
