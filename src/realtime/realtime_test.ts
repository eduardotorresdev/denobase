import { assertEquals } from "@std/assert";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import type { Doc } from "../core/types.ts";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";
import { parseSubscription } from "./mod.ts";
import { tx } from "../core/db.ts";
import { forbidden } from "../core/errors.ts";

const rt_users = defineCollection({
  slug: "rt_users",
  auth: true,
  fields: [{ name: "nome", type: "text" }],
  access: { read: ({ user }) => (user ? { id: { equals: user.id } } : false) },
});
const rt_notas = defineCollection({
  slug: "rt_notas",
  fields: [
    { name: "texto", type: "text" },
    { name: "dono", type: "relationship", relationTo: "rt_users" },
  ],
  // Like a PB rule `dono = @request.auth.id`: each user sees only their notes.
  access: { read: ({ user }) => (user ? { dono: { equals: user.id } } : false) },
});
registerCollections(rt_users, rt_notas);

interface Sse {
  id: string;
  event: string;
  data: unknown;
}

/** Reads SSE frames off a GET /api/realtime response; next() waits up to ms for the next one. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const queue: Sse[] = [];
  const pull = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed");
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f = Object.fromEntries(
        raw.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]),
      );
      queue.push({ id: f.id, event: f.event, data: JSON.parse(f.data) });
    }
  };
  return {
    async next(ms = 500): Promise<Sse | null> {
      const deadline = Date.now() + ms;
      while (!queue.length) {
        const left = deadline - Date.now();
        if (left <= 0) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"t">((r) => timer = setTimeout(() => r("t"), left));
        const got = await Promise.race([pull().then(() => "ok" as const), timeout]);
        clearTimeout(timer);
        if (got === "t") return null;
      }
      return queue.shift()!;
    },
    cancel: () => reader.cancel(),
  };
}

async function setup() {
  const db = await dbWith([rt_users, rt_notas]);
  const { http: app, store, realtime } = createApp({ db, mailer: new MemoryMailer() });
  const users = store.collection(rt_users);
  const ana = await users.create({ email: "ana@x.io", password: "12345678", passwordConfirm: "12345678" });
  const bia = await users.create({ email: "bia@x.io", password: "12345678", passwordConfirm: "12345678" });
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { Authorization: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const connect = async () => {
    const res = await app.request("/api/realtime");
    const sse = sseReader(res);
    const hello = (await sse.next())!;
    return { res, sse, hello, clientId: (hello.data as { clientId: string }).clientId };
  };
  return { db, app, store, realtime, ana, bia, call, connect, token: (u: Doc) => tokenFor(db, "rt_users", u) };
}

Deno.test("connect streams PB_CONNECT with a 40-char client id, in PB's framing and headers", async () => {
  const t = await setup();
  const { res, sse, hello, clientId } = await t.connect();
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("x-accel-buffering"), "no");
  assertEquals(hello.event, "PB_CONNECT");
  assertEquals(hello.id, clientId);
  assertEquals(/^[A-Za-z0-9]{40}$/.test(clientId), true);
  await sse.cancel();
});

Deno.test("subscribe validates like PB: blank client 400, unknown client 404, auth switch 403, ok 204", async () => {
  const t = await setup();
  const blank = await t.call("POST", "/api/realtime", { subscriptions: [] });
  assertEquals([blank.status, (await blank.json()).data.clientId.code], [400, "validation_required"]);
  const unknown = await t.call("POST", "/api/realtime", { clientId: "nope", subscriptions: [] });
  assertEquals([unknown.status, (await unknown.json()).message], [404, "Missing or invalid client id."]);
  const { sse, clientId } = await t.connect();
  const ok = await t.call("POST", "/api/realtime", { clientId, subscriptions: ["rt_notas/*"] }, await t.token(t.ana));
  assertEquals(ok.status, 204);
  const other = await t.call("POST", "/api/realtime", { clientId, subscriptions: [] }, await t.token(t.bia));
  assertEquals([other.status, (await other.json()).message], [
    403,
    "The current and the previous request authorization don't match.",
  ]);
  await sse.cancel();
});

Deno.test("create/update/delete reach only subscribers the read rule lets see the record", async () => {
  const t = await setup();
  const anaC = await t.connect();
  const biaC = await t.connect();
  await t.call(
    "POST",
    "/api/realtime",
    { clientId: anaC.clientId, subscriptions: ["rt_notas/*"] },
    await t.token(t.ana),
  );
  await t.call(
    "POST",
    "/api/realtime",
    { clientId: biaC.clientId, subscriptions: ["rt_notas/*"] },
    await t.token(t.bia),
  );
  const notas = t.store.collection(rt_notas);
  const n = await notas.create({ texto: "oi", dono: t.ana.id });
  const created = (await anaC.sse.next())!;
  assertEquals(created.event, "rt_notas/*");
  assertEquals(created.id, anaC.clientId);
  assertEquals(created.data, { record: { ...n }, action: "create" });
  // Key order is PB's recordData: record first, then action.
  assertEquals(Object.keys(created.data as object), ["record", "action"]);
  assertEquals(await biaC.sse.next(200), null);
  await notas.update(n.id, { texto: "tchau" });
  assertEquals(((await anaC.sse.next())!.data as { action: string }).action, "update");
  await notas.delete(n.id);
  const deleted = (await anaC.sse.next())!;
  assertEquals([deleted.data as { action: string; record: Doc }].map((d) => [d.action, d.record.id]), [[
    "delete",
    n.id,
  ]]);
  assertEquals(await biaC.sse.next(200), null);
  await anaC.sse.cancel();
  await biaC.sse.cancel();
});

Deno.test("record topics and ?options= (fields, expand, filter) shape each subscription's events", async () => {
  const t = await setup();
  const c = await t.connect();
  const n = await t.store.collection(rt_notas).create({ texto: "um", dono: t.ana.id });
  const opts = (o: unknown) => `?options=${encodeURIComponent(JSON.stringify(o))}`;
  const one = `rt_notas/${n.id}${opts({ query: { fields: "id,texto,expand.dono.nome", expand: "dono" } })}`;
  const filtered = `rt_notas/*${opts({ query: { filter: "texto = 'dois'" } })}`;
  await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: [one, filtered] }, await t.token(t.ana));
  await t.store.collection(rt_users).update(t.ana.id, { nome: "Ana" });
  await t.store.collection(rt_notas).update(n.id, { texto: "dois" });
  const got = [(await c.sse.next())!, (await c.sse.next())!].sort((a, b) => a.event.localeCompare(b.event));
  assertEquals(got.map((e) => e.event), [filtered, one].sort());
  const single = got.find((e) => e.event === one)!.data as { record: Doc };
  assertEquals(single.record, { id: n.id, texto: "dois", expand: { dono: { nome: "Ana" } } });
  await c.sse.cancel();
});

Deno.test("a password change drops the client's auth, so later events need a new subscribe", async () => {
  const t = await setup();
  const c = await t.connect();
  await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: ["rt_notas/*"] }, await t.token(t.ana));
  await t.store.collection(rt_users).update(t.ana.id, { password: "87654321", passwordConfirm: "87654321" });
  await t.store.collection(rt_notas).create({ texto: "x", dono: t.ana.id });
  assertEquals(await c.sse.next(200), null);
  await c.sse.cancel();
});

Deno.test("parseSubscription reads ?options= like PB: values to strings, headers snake_case", () => {
  const sub = `x/*?options=${
    encodeURIComponent(JSON.stringify({ query: { a: 1, b: "z" }, headers: { "X-Token": "t" } }))
  }`;
  assertEquals(parseSubscription(sub), { query: { a: "1", b: "z" }, headers: { x_token: "t" } });
  assertEquals(parseSubscription("x/*"), { query: {}, headers: {} });
});

Deno.test("publish reaches clients subscribed to exactly that topic, authenticated by default", async () => {
  const t = await setup();
  const ana = await t.connect();
  const guest = await t.connect();
  const other = await t.connect();
  await t.call("POST", "/api/realtime", { clientId: ana.clientId, subscriptions: ["painel"] }, await t.token(t.ana));
  await t.call("POST", "/api/realtime", { clientId: guest.clientId, subscriptions: ["painel"] });
  await t.call(
    "POST",
    "/api/realtime",
    { clientId: other.clientId, subscriptions: ["painel/x"] },
    await t.token(t.bia),
  );
  const { realtime } = t;
  assertEquals(await realtime.publish("painel", { pedidos: 3 }), 1);
  const got = (await ana.sse.next())!;
  assertEquals([got.event, got.id, got.data], ["painel", ana.clientId, { pedidos: 3 }]);
  assertEquals(await guest.sse.next(200), null);
  assertEquals(await other.sse.next(200), null);
  for (const c of [ana, guest, other]) await c.sse.cancel();
});

Deno.test("publish access decides per client, with the client's req", async () => {
  const t = await setup();
  const ana = await t.connect();
  const bia = await t.connect();
  const guest = await t.connect();
  for (const [c, tok] of [[ana, await t.token(t.ana)], [bia, await t.token(t.bia)], [guest, undefined]] as const) {
    await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: ["avisos"] }, tok);
  }
  const sent = await t.realtime.publish("avisos", "oi", {
    access: ({ auth, req }) => !auth || req.user?.id === t.bia.id,
  });
  assertEquals(sent, 2);
  assertEquals((await bia.sse.next())!.data, "oi");
  assertEquals((await guest.sse.next())!.data, "oi");
  assertEquals(await ana.sse.next(200), null);
  for (const c of [ana, bia, guest]) await c.sse.cancel();
});

Deno.test("publish inside a transaction leaves after commit and never on rollback", async () => {
  const t = await setup();
  const c = await t.connect();
  await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: ["fila"] }, await t.token(t.ana));
  await tx(t.db, async () => {
    await t.realtime.publish("fila", 1);
    throw new Error("rollback");
  }).catch(() => {});
  assertEquals(await c.sse.next(200), null);
  await tx(t.db, async () => {
    await t.realtime.publish("fila", 2);
  });
  assertEquals((await c.sse.next())!.data, 2);
  await c.sse.cancel();
});

Deno.test("a subscribe guard sees the requested topics and its refusal keeps the previous subscriptions", async () => {
  const t = await setup();
  const seen: string[][] = [];
  t.realtime.onSubscribe(({ topics, auth }) => {
    seen.push(topics);
    if (topics.some((s) => s.startsWith("fechado/")) && !auth) throw forbidden("Fechado");
  });
  const c = await t.connect();
  const ok = await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: ["aberto", ""] });
  assertEquals(ok.status, 204);
  const refused = await t.call("POST", "/api/realtime", { clientId: c.clientId, subscriptions: ["fechado/1"] });
  assertEquals([refused.status, (await refused.json()).message], [403, "Fechado"]);
  assertEquals([...t.realtime.clients.get(c.clientId)!.subscriptions.keys()], ["aberto"]);
  const authed = await t.call(
    "POST",
    "/api/realtime",
    { clientId: c.clientId, subscriptions: ["fechado/1"] },
    await t.token(t.ana),
  );
  assertEquals(authed.status, 204);
  assertEquals(seen, [["aberto"], ["fechado/1"], ["fechado/1"]]);
  await c.sse.cancel();
});

Deno.test("a subscribe hook refuses with its error and keeps the subscriptions; it sees the requester", async () => {
  const t = await setup();
  const seen: (string | null)[] = [];
  t.realtime.onSubscribe(({ client, auth, req, subscriptions }) => {
    seen.push(auth?.id ?? null);
    if (subscriptions.includes("fechado")) throw forbidden("Proibido.");
    assertEquals(req.user?.id, auth?.id);
    client.data.set("subs", subscriptions.length);
  });
  const { sse, clientId } = await t.connect();
  const token = await t.token(t.ana);
  assertEquals((await t.call("POST", "/api/realtime", { clientId, subscriptions: ["a", "b"] }, token)).status, 204);
  const refused = await t.call("POST", "/api/realtime", { clientId, subscriptions: ["fechado"] }, token);
  assertEquals([refused.status, (await refused.json()).message], [403, "Proibido."]);
  const client = t.realtime.clients.get(clientId)!;
  assertEquals([...client.subscriptions.keys()], ["a", "b"]);
  assertEquals(client.data.get("subs"), 2);
  assertEquals(seen, [t.ana.id, t.ana.id]);
  await sse.cancel();
});

Deno.test("a disconnect hook runs once when the stream closes, with the client's data; a failing one is logged", async () => {
  const t = await setup();
  const closed: unknown[] = [];
  t.realtime.onDisconnect(() => {
    throw new Error("boom");
  });
  t.realtime.onDisconnect(({ client }) => void closed.push(client.data.get("k")));
  const { sse, clientId } = await t.connect();
  t.realtime.clients.get(clientId)!.data.set("k", "v");
  const err = console.error;
  console.error = () => {};
  try {
    await sse.cancel();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = err;
  }
  assertEquals(closed, ["v"]);
  assertEquals(t.realtime.clients.has(clientId), false);
});
