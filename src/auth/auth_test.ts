import { assert, assertEquals, assertRejects } from "@std/assert";
import { openDb } from "../core/db.ts";
import { ApiError } from "../core/errors.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { hashPassword, newTokenKey, verifyPassword } from "./password.ts";
import { hmacKeyCacheSize, signAuthToken, verifyAuthToken } from "./jwt.ts";
import { deleteExpiredOtps, ensureOtpTable, OTP_MAX_ATTEMPTS, requestOtp, verifyOtp } from "./otp.ts";
import { HttpMailer, MemoryMailer } from "./mailer.ts";

// Auth only accepts registered auth collections, as a consumer would register its own.
registerCollections(defineCollection({ slug: "users", auth: {}, fields: [] }));

// Minimal users table by hand: the auth module only depends on the implicit auth columns.
function setup() {
  const db = openDb();
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, passwordHash TEXT, tokenKey TEXT, verified INTEGER)`);
  db.prepare(`INSERT INTO users VALUES ('u1', 'a@x.com', '', ?, 0)`).run(newTokenKey());
  ensureOtpTable(db);
  return db;
}
const tokenKeyOf = (db: ReturnType<typeof setup>) =>
  (db.prepare(`SELECT tokenKey FROM users WHERE id='u1'`).get() as { tokenKey: string }).tokenKey;
const codeOf = (m: MemoryMailer) => m.sent.at(-1)!.html.match(/<strong>(\d{8})<\/strong>/)![1];

Deno.test("password hash verifies only the right password", async () => {
  const h = await hashPassword("password123", 4);
  assert(await verifyPassword("password123", h));
  assert(!(await verifyPassword("wrong", h)));
  assert(!(await verifyPassword("x", "")));
});

Deno.test("token verifies, hides secrets and dies on tokenKey rotation", async () => {
  const db = setup();
  const token = await signAuthToken("users", { id: "u1", tokenKey: tokenKeyOf(db) });
  const user = await verifyAuthToken(db, token);
  assertEquals(user?.id, "u1");
  assertEquals(user?.collection, "users");
  assertEquals(user?.record.tokenKey, undefined);
  db.prepare(`UPDATE users SET tokenKey = ? WHERE id='u1'`).run(newTokenKey());
  assertEquals(await verifyAuthToken(db, token), null);
  assertEquals(await verifyAuthToken(db, "garbage"), null);
});

Deno.test("expired token is rejected", async () => {
  const db = setup();
  const token = await signAuthToken("users", { id: "u1", tokenKey: tokenKeyOf(db) }, -10);
  assertEquals(await verifyAuthToken(db, token), null);
});

Deno.test("otp: unknown email gets an otpId but no mail", async () => {
  const db = setup();
  const m = new MemoryMailer();
  const { otpId } = await requestOtp(db, m, "users", "nobody@x.com");
  assert(otpId);
  assertEquals(m.sent.length, 0);
});

Deno.test("otp: the answer never waits for the provider; a failed send deletes the otp and is reported", async () => {
  const db = setup();
  const otps = () => (db.prepare(`SELECT COUNT(*) n FROM _otps`).get() as { n: number }).n;
  const stuck = { send: () => new Promise<void>(() => {}) };
  assert((await requestOtp(db, stuck, "users", "a@x.com")).otpId);
  assertEquals(otps(), 1);

  const errors: unknown[] = [];
  const down = { send: () => Promise.reject(new Error("smtp down")) };
  const { otpId } = await requestOtp(db, down, "users", "a@x.com", undefined, (e) => errors.push(e));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals([otps(), (errors[0] as Error).message], [1, "smtp down"]);
  assertEquals(db.prepare(`SELECT id FROM _otps WHERE id = ?`).get(otpId), undefined);
});

Deno.test("otp: right code logs in once and verifies email", async () => {
  const db = setup();
  const m = new MemoryMailer();
  const { otpId } = await requestOtp(db, m, "users", "A@x.com");
  const rec = await verifyOtp(db, "users", otpId, codeOf(m));
  assertEquals(rec.id, "u1");
  assertEquals(rec.verified, 1);
  await assertRejects(() => verifyOtp(db, "users", otpId, codeOf(m)), ApiError);
});

Deno.test("otp: attempt limit burns the code", async () => {
  const db = setup();
  const m = new MemoryMailer();
  const { otpId } = await requestOtp(db, m, "users", "a@x.com");
  for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await assertRejects(() => verifyOtp(db, "users", otpId, "nope"), ApiError);
  await assertRejects(() => verifyOtp(db, "users", otpId, codeOf(m)), ApiError);
});

Deno.test("otp: expired code is rejected", async () => {
  const db = setup();
  const m = new MemoryMailer();
  const { otpId } = await requestOtp(db, m, "users", "a@x.com");
  db.prepare(`UPDATE _otps SET expires = 0`).run();
  await assertRejects(() => verifyOtp(db, "users", otpId, codeOf(m)), ApiError);
});

Deno.test("http mailer posts Resend payload and throws on error status", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const fake = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  const m = new HttpMailer("k", "from@x.com", "https://mail.test/emails", fake);
  await m.send({ to: "a@x.com", subject: "s", html: "<p>h</p>" });
  assertEquals(calls[0].url, "https://mail.test/emails");
  assertEquals(JSON.parse(String(calls[0].init.body)).to, ["a@x.com"]);
  status = 422;
  await assertRejects(() => m.send({ to: "a@x.com", subject: "s", html: "h" }));
});

Deno.test("verify reuses the imported HMAC key and a new tokenKey still kills old tokens", async () => {
  const db = setup();
  const token = await signAuthToken("users", { id: "u1", tokenKey: tokenKeyOf(db) });
  const size = hmacKeyCacheSize();
  assertEquals((await verifyAuthToken(db, token))?.id, "u1");
  assertEquals((await verifyAuthToken(db, token))?.id, "u1");
  assertEquals(hmacKeyCacheSize(), size);
  db.prepare(`UPDATE users SET tokenKey = ? WHERE id = 'u1'`).run(newTokenKey());
  assertEquals(await verifyAuthToken(db, token), null);
});

Deno.test("OTP cleanup drops only expired codes, across batches", async () => {
  const db = setup();
  const ins = db.prepare(
    `INSERT INTO _otps (id, collection, recordId, codeHash, expires, created) VALUES (?, 'users', 'u1', '', ?, '')`,
  );
  for (let i = 0; i < 1200; i++) ins.run(`old${i}`, 1);
  ins.run("fresh", Date.now() + 60_000);
  await deleteExpiredOtps(db);
  assertEquals((db.prepare(`SELECT id FROM _otps`).all() as { id: string }[]).map((r) => r.id), ["fresh"]);
});
