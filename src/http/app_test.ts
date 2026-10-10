import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { corsOrigins, tokenFromHeader } from "./app.ts";
import { createApp } from "../app.ts";
import type { Services } from "./services.ts";
import { ApiError, notFound } from "../core/errors.ts";
import type { AuthUser, CollectionConfig, Doc } from "../core/types.ts";
import type { Mailer } from "../auth/mailer.ts";

const cols: CollectionConfig[] = [
  { slug: "users", auth: { otp: { enabled: true } }, fields: [] },
  { slug: "cargos", fields: [{ name: "titulo", type: "text" }] },
];
const alice: AuthUser = { id: "alice", collection: "users", record: { id: "alice" } };
const mailer: Mailer = { send: () => Promise.resolve() } as unknown as Mailer;

/** Fake collaborators record calls so routes are tested without engine/auth implementations. */
function setup(over: Partial<Services> = {}) {
  const calls: Record<string, unknown[]> = {};
  const log = (k: string, a: unknown) => (calls[k] ??= []).push(a);
  const services: Partial<Services> = {
    verifyAuthToken: (_db, t) => Promise.resolve(t === "good" ? alice : null),
    find: (a) => {
      log("find", a);
      return Promise.resolve({ page: a.page ?? 1, perPage: a.perPage ?? 30, totalItems: 0, totalPages: 0, items: [] });
    },
    findById: (a) => {
      log("findById", a);
      if (a.id === "missing") throw notFound();
      return Promise.resolve({ id: a.id } as Doc);
    },
    create: (a) => {
      log("create", a);
      return Promise.resolve({ id: "new", ...a.data } as Doc);
    },
    update: (a) => {
      log("update", a);
      return Promise.resolve({ id: a.id, ...a.data } as Doc);
    },
    remove: (a) => {
      log("remove", a);
      return Promise.resolve();
    },
    credentials: (_db, _slug, by) =>
      by.email === "a@x.io" || by.id === "alice" ? { id: "alice", passwordHash: "h", tokenKey: "k" } : null,
    verifyPassword: (p) => Promise.resolve(p === "secret"),
    signAuthToken: (c, r) => Promise.resolve(`tok:${c}:${r.id}`),
    requestOtp: () => Promise.resolve({ otpId: "otp1" }),
    verifyOtp: (_db, _c, id, code) => {
      if (id !== "otp1" || code !== "123456") throw new ApiError(400, "Invalid or expired OTP");
      return Promise.resolve({ id: "alice" } as Doc);
    },
    ...over,
  };
  const app = createApp({ db: new DatabaseSync(":memory:"), mailer, collections: cols, services }).http;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(opts.token ? { Authorization: opts.token } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  return { call, calls };
}

Deno.test("tokenFromHeader accepts bearer and raw tokens", () => {
  assertEquals(tokenFromHeader("Bearer abc"), "abc");
  assertEquals(tokenFromHeader("abc"), "abc");
  assertEquals(tokenFromHeader(undefined), null);
});

Deno.test("list passes query params and resolved user to engine", async () => {
  const { call, calls } = setup();
  const res = await call("GET", "/api/collections/cargos/records?filter=titulo%3D'a'&sort=-created&page=2&perPage=5", {
    token: "Bearer good",
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).page, 2);
  const a = calls.find[0] as { filter: string; sort: string; perPage: number; req: { user: AuthUser } };
  assertEquals([a.filter, a.sort, a.perPage, a.req.user.id], ["titulo='a'", "-created", 5, "alice"]);
});

Deno.test("invalid token is treated as guest", async () => {
  const { call, calls } = setup();
  await call("GET", "/api/collections/cargos/records", { token: "bad" });
  assertEquals((calls.find[0] as { req: { user: unknown } }).req.user, null);
});

Deno.test("unknown collection and missing record answer PB 404 JSON", async () => {
  const { call } = setup();
  const r1 = await call("GET", "/api/collections/nope/records");
  assertEquals(r1.status, 404);
  assertEquals(Object.keys(await r1.json()).sort(), ["data", "message", "status"]);
  assertEquals((await call("GET", "/api/collections/cargos/records/missing")).status, 404);
});

Deno.test("create, update and delete delegate to engine", async () => {
  const { call } = setup();
  assertEquals(await (await call("POST", "/api/collections/cargos/records", { body: { titulo: "x" } })).json(), {
    id: "new",
    titulo: "x",
  });
  assertEquals(
    (await (await call("PATCH", "/api/collections/cargos/records/r1", { body: { titulo: "y" } })).json()).id,
    "r1",
  );
  assertEquals((await call("DELETE", "/api/collections/cargos/records/r1")).status, 204);
});

Deno.test("malformed body is 400, unexpected error is 500 PB JSON", async () => {
  const { call } = setup({ create: () => Promise.reject(new Error("boom")) });
  assertEquals((await call("POST", "/api/collections/cargos/records", { body: [1] })).status, 400);
  const console_error = console.error;
  console.error = () => {};
  try {
    const r = await call("POST", "/api/collections/cargos/records", { body: {} });
    assertEquals(r.status, 500);
    assertEquals((await r.json()).status, 500);
  } finally {
    console.error = console_error;
  }
});

Deno.test("auth-with-password returns token and record, same error for bad email or password", async () => {
  const { call } = setup();
  const ok = await call("POST", "/api/collections/users/auth-with-password", {
    body: { identity: "a@x.io", password: "secret" },
  });
  assertEquals(await ok.json(), { token: "tok:users:alice", record: { id: "alice" } });
  const wrong = await call("POST", "/api/collections/users/auth-with-password", {
    body: { identity: "a@x.io", password: "nope" },
  });
  const unknown = await call("POST", "/api/collections/users/auth-with-password", {
    body: { identity: "z@x.io", password: "secret" },
  });
  assertEquals([wrong.status, unknown.status], [400, 400]);
  assertEquals((await wrong.json()).message, (await unknown.json()).message);
});

Deno.test("auth routes answer PB's 404 for non-auth collections", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/collections/cargos/auth-with-password", {
    body: { identity: "a", password: "b" },
  });
  assertEquals([r.status, (await r.json()).message], [404, "Missing or invalid auth collection context."]);
});

Deno.test("otp flow: request then auth-with-otp", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/collections/users/request-otp", { body: { email: "a@x.io" } });
  assertEquals(await r.json(), { otpId: "otp1" });
  const bad = await call("POST", "/api/collections/users/auth-with-otp", { body: { otpId: "otp1", password: "0" } });
  assertEquals(bad.status, 400);
  const ok = await call("POST", "/api/collections/users/auth-with-otp", {
    body: { otpId: "otp1", password: "123456" },
  });
  assertEquals((await ok.json()).token, "tok:users:alice");
});

Deno.test("auth-refresh needs a token of the same collection", async () => {
  const { call } = setup();
  assertEquals((await call("POST", "/api/collections/users/auth-refresh")).status, 401);
  const ok = await call("POST", "/api/collections/users/auth-refresh", { token: "good" });
  assertEquals((await ok.json()).record.id, "alice");
});

Deno.test("cors: every origin by default like PB, and a preflight answers before auth and routes", async () => {
  const app = createApp({ db: new DatabaseSync(":memory:"), collections: [] }).http;
  const pre = await app.request("/api/collections/users/auth-with-password", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5199", "Access-Control-Request-Method": "POST" },
  });
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "*");
  const get = await app.request("/api/health", { headers: { Origin: "http://localhost:5199" } });
  assertEquals(get.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("cors: DENOBASE_ORIGINS narrows the allowed origins; '*' anywhere in it keeps every origin", () => {
  assertEquals(corsOrigins(""), "*");
  assertEquals(corsOrigins(" https://a.com , https://b.com "), ["https://a.com", "https://b.com"]);
  assertEquals(corsOrigins("https://a.com,*"), "*");
});
