import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../app.ts";
import { HttpMailer, MemoryMailer } from "../auth/mailer.ts";
import { collectSpans } from "../testing/mod.ts";
import { tracedFetch } from "./instrument/fetch.ts";

function setup(traces: Record<string, unknown> = {}) {
  const app = createApp({
    db: new DatabaseSync(":memory:"),
    mailer: new MemoryMailer(),
    adminUiDir: false,
    settings: { traces: { propagateHosts: ["example.com"], ...traces } },
  });
  return { app, collected: collectSpans(app) };
}

Deno.test("mailer: mail.send span with an HTTP client child that sends traceparent, no recipients kept", async () => {
  const { app, collected } = setup();
  const seen: [unknown, RequestInit | undefined][] = [];
  // The consumer's fetchFn signature: (url, init), traced or not.
  const stub: typeof fetch = (input, init) => {
    seen.push([input, init]);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const mailer = new HttpMailer("k", "from@x.io", "https://mail.example.com/emails", stub);
  await app.tracer.span("job", undefined, () => mailer.send({ to: "secret@x.io", subject: "s", html: "<p/>" }));
  const spans = collected.spans();
  const mail = spans.find((s) => s.name === "mail.send")!;
  const http = spans.find((s) => s.name === "HTTP POST")!;
  assertEquals(http.parentId, mail.id);
  assertEquals([http.kind, http.attributes["server.address"], http.attributes["http.response.status_code"]], [
    2,
    "mail.example.com",
    200,
  ]);
  assertEquals(seen[0][0], "https://mail.example.com/emails");
  assertEquals(typeof seen[0][1]?.body, "string");
  assertEquals(new Headers(seen[0][1]?.headers).get("traceparent"), `00-${http.traceId}-${http.id}-01`);
  assertEquals(new Headers(seen[0][1]?.headers).get("authorization"), "Bearer k");
  assertEquals(JSON.stringify(spans).includes("secret@x.io"), false);
});

Deno.test("fetch: app.tracer.fetch marks 5xx and network errors as error; untraced calls pass through", async () => {
  const { app, collected } = setup();
  const orig = globalThis.fetch;
  let headers: Headers | undefined;
  globalThis.fetch = (input, init) => {
    const r = input instanceof Request ? input : new Request(input, init);
    headers = r.headers;
    if (r.url.includes("down")) return Promise.reject(new TypeError("connection refused"));
    return Promise.resolve(new Response("x", { status: 503 }));
  };
  try {
    await app.tracer.span("root", undefined, async () => {
      await (await app.tracer.fetch("https://api.example.com/a")).text();
      await app.tracer.fetch("https://down.example.com/").catch(() => {});
    });
    await (await app.tracer.fetch("https://api.example.com/untraced")).text();
    assertEquals(headers?.has("traceparent"), false);
  } finally {
    globalThis.fetch = orig;
  }
  const http = collected.spans().filter((s) => s.name === "HTTP GET");
  assertEquals(http.map((s) => s.status), [2, 2]);
  assertEquals(http[1].events[0].attributes?.["exception.message"], "connection refused");
});

Deno.test("realtime: publish is a producer span with the topic and how many clients got it", async () => {
  const { app, collected } = setup();
  await app.tracer.span("root", undefined, () => app.realtime.publish("pedidos/alerta", { a: 1 }));
  const s = collected.spans().find((x) => x.name === "realtime.publish")!;
  assertEquals([s.kind, s.attributes["messaging.destination.name"], s.attributes["realtime.clients"]], [
    3,
    "pedidos/alerta",
    0,
  ]);
});

Deno.test("logs: any entry written inside a trace carries its ids; outside, none", async () => {
  const { app } = setup();
  let ids: { traceId: string; spanId: string } | null = null;
  await app.tracer.span("root", undefined, () => {
    ids = app.tracer.current();
    app.logs.add(0, "dentro", { k: 1 });
  });
  app.logs.add(0, "fora", {});
  const byMsg = Object.fromEntries(app.logs.list({}).items.map((l) => [l.message, l.data]));
  assertEquals(byMsg.dentro, { k: 1, ...ids! });
  assertEquals(byMsg.fora, {});
});

Deno.test("retention: the traces cleanup job drops spans older than settings.traces.maxDays", async () => {
  const { app } = setup();
  const old = Math.round((Date.now() - 10 * 86_400_000) * 1000);
  app.traces.insertMany([
    {
      id: "1".repeat(16),
      traceId: "1".repeat(32),
      parentId: "",
      name: "old",
      kind: 1,
      status: 0,
      start: old,
      duration: 1,
      root: true,
      attributes: {},
      events: [],
    },
  ]);
  app.tracer.startRoot("fresh").end();
  app.tracer.flush();
  await app.cron.get("__denobaseTracesCleanup__")!.run();
  app.tracer.flush();
  assertEquals(app.traces.listTraces({ filter: "name!~'cron'" }).items.map((i) => i.name), ["fresh"]);
});

Deno.test("fetch: traceparent goes only to propagateHosts; a third party gets no trace ids", async () => {
  const { app } = setup();
  const got: Record<string, string | null> = {};
  const stub: typeof fetch = (input, init) => {
    got[new URL(String(input)).hostname] = new Headers(init?.headers).get("traceparent");
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  await app.tracer.span("root", undefined, async () => {
    await tracedFetch("https://api.example.com/a", undefined, stub);
    await tracedFetch("https://thirdparty.io/a", { headers: { x: "1" } }, stub);
  });
  assertEquals([got["api.example.com"] !== null, got["thirdparty.io"]], [true, null]);
});
