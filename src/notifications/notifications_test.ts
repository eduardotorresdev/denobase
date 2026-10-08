import { assert, assertEquals, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";
import { createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import { collectSpans, dbWith, tokenFor } from "../testing/mod.ts";
import { notificationCollections, notifications } from "./collections.ts";
import { register } from "./index.ts";
import type { NotificationAuthorize } from "./http.ts";
import type { InboundMessage, NotificationMessage, Provider, ProviderEvents, ProviderStatus } from "./types.ts";
import { useStoreAuthState } from "./whatsapp/auth_state.ts";
import { mergeContacts, quotedOf, toContent, toJid, type WhatsAppContact } from "./whatsapp/provider.ts";

Deno.env.set("BCRYPT_COST", "4");

const nt_users = defineCollection({ slug: "nt_users", auth: true, fields: [], access: { read: () => true } });
registerCollections(...notificationCollections, nt_users);

/** Records what it was asked to send; fails the first `failures` sends. */
class FakeProvider implements Provider {
  readonly channels = ["whatsapp"] as const;
  sent: NotificationMessage[] = [];
  events: ProviderEvents | null = null;
  started = 0;
  stopped = 0;
  constructor(readonly id = "fake", public failures = 0) {}
  send(msg: NotificationMessage) {
    if (this.failures-- > 0) return Promise.reject(new Error("socket closed"));
    this.sent.push(msg);
    return Promise.resolve({ externalId: `ext-${this.sent.length}` });
  }
  status(): ProviderStatus {
    return { state: this.events ? "connected" : "disconnected" };
  }
  start(e: ProviderEvents) {
    this.events = e;
    this.started++;
  }
  stop() {
    this.events = null;
    this.stopped++;
  }
}

async function setup(opts: { authorize?: NotificationAuthorize; failures?: number } = {}) {
  const cs = [superusers, ...notificationCollections, nt_users];
  const db = await dbWith(cs);
  const app = createApp({ db, mailer: new MemoryMailer(), collections: cs, adminUiDir: false });
  const fake = new FakeProvider("fake", opts.failures ?? 0);
  const n = await register(app, { providers: () => [fake], backoffMs: () => 0, authorize: opts.authorize });
  await n.configure("fake", { enabled: true });
  const pw = { password: "12345678", passwordConfirm: "12345678" };
  const su = await app.store.collection(superusers).create({ email: "su@x.io", ...pw } as never);
  const user = await app.store.collection(nt_users).create({ email: "u@x.io", ...pw } as never);
  const req = async (method: string, path: string, token = "", body?: unknown) => {
    const headers: Record<string, string> = token ? { Authorization: token } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await app.http.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  };
  return {
    app,
    n,
    fake,
    req,
    su: await tokenFor(db, "_superusers", su),
    user: await tokenFor(db, "nt_users", user),
  };
}

Deno.test("send: logs the message as sent with the provider's id", async () => {
  const t = await setup();
  const row = await t.n.send({ provider: "fake", to: "5511999999999", text: "pedido pronto" });
  assertEquals([row.status, row.attempts, row.externalId, row.channel], ["sent", 1, "ext-1", "whatsapp"]);
  assertEquals(t.fake.sent[0].text, "pedido pronto");
});

Deno.test("send: retries a failing provider and records the attempts", async () => {
  const t = await setup({ failures: 2 });
  const row = await t.n.send({ provider: "fake", to: "1", text: "x" });
  assertEquals([row.status, row.attempts], ["sent", 3]);
});

Deno.test("send: each provider attempt is a notification.send span; a failed attempt is an error", async () => {
  const t = await setup({ failures: 1 });
  const collected = collectSpans(t.app);
  await t.app.tracer.span("job", undefined, () => t.n.send({ provider: "fake", to: "1", text: "x" }));
  const sends = collected.spans().filter((s) => s.name === "notification.send");
  assertEquals(
    sends.map((s) => [s.attributes["notification.provider"], s.attributes["notification.attempt"], s.status]),
    [
      ["fake", 1, 2],
      ["fake", 2, 0],
    ],
  );
  assertEquals(sends[0].attributes["notification.channel"], "whatsapp");
});

Deno.test("send: gives up after maxAttempts with the last error, and retry sends it again", async () => {
  const t = await setup({ failures: 3 });
  const failed = await t.n.send({ provider: "fake", to: "1", text: "x" });
  assertEquals([failed.status, failed.attempts, failed.error], ["failed", 3, "socket closed"]);
  const again = await t.n.retry(failed.id);
  assertEquals([again.status, again.attempts], ["sent", 4]);
  await assertRejects(() => t.n.retry(again.id), Error, "Only failed");
});

Deno.test("send: refuses a message without text or media, and an unknown provider", async () => {
  const t = await setup();
  await assertRejects(() => t.n.send({ provider: "fake", to: "1" }), Error, "text or media");
  await assertRejects(() => t.n.send({ provider: "nope", to: "1", text: "x" }), Error, "nope");
});

Deno.test("send: inline media payload never lands in the log", async () => {
  const t = await setup();
  const data = Buffer.from("pdf").toString("base64");
  const row = await t.n.send({ provider: "fake", to: "1", media: { kind: "document", data, filename: "os.pdf" } });
  assertEquals(row.media, { kind: "document", filename: "os.pdf" });
  assertEquals(t.fake.sent[0].media?.data, data);
});

Deno.test("receipts only move a message forward", async () => {
  const t = await setup();
  const row = await t.n.send({ provider: "fake", to: "1", text: "x" });
  await t.fake.events!.receipt("fake", "ext-1", "read");
  await t.fake.events!.receipt("fake", "ext-1", "delivered");
  assertEquals((await t.app.store.collection(notifications).get(row.id)).status, "read");
});

Deno.test("inbound messages reach every listener, even when one throws", async () => {
  const t = await setup();
  const got: InboundMessage[] = [];
  t.n.onInbound(() => {
    throw new Error("boom");
  });
  t.n.onInbound((m) => void got.push(m));
  const msg = {
    provider: "fake",
    from: "551199@s.whatsapp.net",
    externalId: "in-1",
    text: "oi",
    timestamp: 1,
    raw: {},
  };
  const err = console.error;
  console.error = () => {};
  try {
    await t.fake.events!.inbound(msg);
  } finally {
    console.error = err;
  }
  assertEquals(got.map((m) => m.text), ["oi"]);
});

Deno.test("providers start only when enabled, stop when disabled and on app.terminate", async () => {
  const t = await setup();
  assertEquals(t.fake.started, 1);
  await t.n.configure("fake", { enabled: false });
  assertEquals(t.fake.stopped, 1);
  await t.n.configure("fake", { enabled: true, config: { k: 1 } });
  assertEquals([t.fake.started, await t.n.config("fake")], [2, { k: 1 }]);
  await t.app.terminate();
  assertEquals(t.fake.stopped, 2);
});

Deno.test("http: superuser only by default", async () => {
  const t = await setup();
  assertEquals((await t.req("GET", "/api/notifications/providers")).status, 401);
  assertEquals((await t.req("GET", "/api/notifications/providers", t.user)).status, 403);
  const r = await t.req("GET", "/api/notifications/providers", t.su);
  assertEquals(r.json, [{ id: "fake", channels: ["whatsapp"], status: { state: "connected" }, enabled: true }]);
});

Deno.test("http: send, list with filters and retry", async () => {
  const t = await setup({ failures: 3 });
  const sent = await t.req("POST", "/api/notifications/send", t.su, { provider: "fake", to: "1", text: "a" });
  assertEquals([sent.status, sent.json.status], [200, "failed"]);
  await t.req("POST", "/api/notifications/send", t.su, { provider: "fake", to: "2", text: "b" });
  const failed = await t.req("GET", "/api/notifications?status=failed", t.su);
  assertEquals([failed.json.totalItems, failed.json.items[0].to], [1, "1"]);
  assertEquals((await t.req("GET", "/api/notifications?perPage=1", t.su)).json.totalPages, 2);
  const retried = await t.req("POST", `/api/notifications/${sent.json.id}/retry`, t.su);
  assertEquals(retried.json.status, "sent");
  assertEquals((await t.req("POST", "/api/notifications/send", t.su, { provider: "fake", to: "1" })).status, 400);
});

Deno.test("http: a consumer may open send to its users while the rest stays closed", async () => {
  const t = await setup({ authorize: (u, action) => u?.collection === "_superusers" || (!!u && action === "send") });
  const ok = await t.req("POST", "/api/notifications/send", t.user, { provider: "fake", to: "1", text: "x" });
  assertEquals(ok.status, 200);
  assertEquals((await t.req("GET", "/api/notifications", t.user)).status, 403);
  assertEquals((await t.req("POST", "/api/notifications/send", "", { provider: "fake", to: "1" })).status, 401);
});

Deno.test("http: whatsapp routes answer 404 when the provider is not registered", async () => {
  const t = await setup();
  assertEquals((await t.req("GET", "/api/notifications/whatsapp/status", t.su)).status, 404);
});

Deno.test("whatsapp auth state: creds and keys survive a reload, Buffers included", async () => {
  const t = await setup();
  // Baileys draws registrationId in 0..255 (one random byte), so a value it never draws tells saved from fresh creds.
  const SAVED_ID = 20000;
  const a = await useStoreAuthState(t.app.store, "s1");
  Object.assign(a.state.creds, { registrationId: SAVED_ID });
  await a.saveCreds();
  await a.state.keys.set({ "pre-key": { "1": { public: new Uint8Array([1, 2]), private: new Uint8Array([3]) } } });
  const b = await useStoreAuthState(t.app.store, "s1");
  assertEquals(b.state.creds.registrationId, SAVED_ID);
  const keys = await b.state.keys.get("pre-key", ["1", "2"]);
  assertEquals([...keys["1"].public], [1, 2]);
  assert(!("2" in keys));
  await b.clear();
  const c = await useStoreAuthState(t.app.store, "s1");
  assert(c.state.creds.registrationId !== SAVED_ID);
  assertEquals(await c.state.keys.get("pre-key", ["1"]), {});
});

Deno.test("whatsapp content: no link preview, no thumbnail work, phone numbers become jids", () => {
  assertEquals(toContent({ text: "https://x.io" }), { text: "https://x.io", linkPreview: null });
  const img = toContent({ media: { kind: "image", url: "https://x.io/a.png" }, text: "c" }) as Record<string, unknown>;
  assertEquals([img.jpegThumbnail, img.caption], ["", "c"]);
  assertEquals(toJid("+55 (11) 99999-0000"), "5511999990000@s.whatsapp.net");
  assertEquals(toJid("123@g.us"), "123@g.us");
});

Deno.test("whatsapp reply: mentions ride the content and the quoted message is rebuilt from id, author and text", () => {
  const c = toContent({ text: "@5511 ok", mentions: ["5511@s.whatsapp.net"] }) as Record<string, unknown>;
  assertEquals(c.mentions, ["5511@s.whatsapp.net"]);
  assertEquals(quotedOf("1@g.us", undefined), undefined);
  assertEquals(quotedOf("1@g.us", { id: "Q1", author: "99@lid", text: "oi" }), {
    quoted: {
      key: { remoteJid: "1@g.us", id: "Q1", fromMe: false, participant: "99@lid" },
      message: { conversation: "oi" },
    },
  });
});

Deno.test("whatsapp contacts: events fold into the book and a partial update keeps the saved name", () => {
  const book: Record<string, WhatsAppContact> = {};
  assert(mergeContacts(book, [{ id: "5511@s.whatsapp.net", name: "Ana", notify: "Aninha" }, { id: "" }]));
  assert(mergeContacts(book, [{ id: "5511@s.whatsapp.net", notify: "Ana B", lid: "9@lid" }]));
  assert(!mergeContacts(book, [{ id: "5511@s.whatsapp.net", notify: "Ana B" }]));
  assertEquals(book["5511@s.whatsapp.net"], {
    id: "5511@s.whatsapp.net",
    phone: "5511@s.whatsapp.net",
    lid: "9@lid",
    name: "Ana",
    notify: "Ana B",
  });
});

Deno.test("email: sends through app.mailer and logs it like any send (channel email, subject as text)", async () => {
  const cs = [superusers, ...notificationCollections, nt_users];
  const app = createApp({ db: await dbWith(cs), mailer: new MemoryMailer(), collections: cs, adminUiDir: false });
  const n = await register(app, { providers: () => [], email: true, backoffMs: () => 0 });
  const mailer = app.mailer as MemoryMailer;
  const row = await n.send({
    provider: "email",
    to: "ana@x.io",
    subject: "Contrato para assinatura",
    html: "<p>link privado</p>",
    replyTo: "vera@x.io",
  });
  assertEquals([row.status, row.channel, row.to, row.text, row.attempts], [
    "sent",
    "email",
    "ana@x.io",
    "Contrato para assinatura",
    1,
  ]);
  // The body is not logged: it may carry a private link.
  assert(!JSON.stringify(row).includes("link privado"));
  assertEquals(mailer.sent.map((m) => [m.to, m.subject, m.html, m.replyTo]), [
    ["ana@x.io", "Contrato para assinatura", "<p>link privado</p>", "vera@x.io"],
  ]);
  assertEquals(n.list().find((p) => p.id === "email"), {
    id: "email",
    channels: ["email"],
    status: { state: "connected" },
  });

  // A mailer that refuses: retried, then failed with its reason; the body is not kept, so retry() refuses.
  mailer.send = () => Promise.reject(new Error("422 invalid to"));
  const failed = await n.send({ provider: "email", to: "x@x.io", subject: "S", html: "<p>b</p>" });
  assertEquals([failed.status, failed.attempts, failed.error], ["failed", 3, "422 invalid to"]);
  await assertRejects(() => n.retry(failed.id), Error, "not kept");

  // An e-mail without subject, or with media, is refused before anything is logged.
  const antes = await app.store.collection(notifications).count();
  await assertRejects(() => n.send({ provider: "email", to: "a@x.io", html: "<p>b</p>" }), Error, "subject");
  await assertRejects(
    () =>
      n.send({ provider: "email", to: "a@x.io", subject: "S", media: { kind: "image", url: "https://x.io/a.png" } }),
    Error,
    "media",
  );
  assertEquals(await app.store.collection(notifications).count(), antes);
});

Deno.test("email: off unless asked; the default registry has no e-mail provider", async () => {
  const t = await setup();
  assertEquals(t.n.list().map((p) => p.id), ["fake"]);
});
