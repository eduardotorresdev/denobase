import { assert, assertEquals, assertFalse } from "@std/assert";
import { safeEqual, verifyS256 } from "./pkce.ts";

Deno.test("pkce: the RFC 7636 appendix B vector verifies; a different verifier does not", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert(await verifyS256(verifier, challenge));
  assertFalse(await verifyS256(verifier.replace("d", "e"), challenge));
});

Deno.test("pkce: a verifier outside 43..128 unreserved characters is refused before hashing", async () => {
  const short = "abc";
  assertFalse(await verifyS256(short, "x"));
  assertFalse(await verifyS256("a".repeat(129), "x"));
  assertFalse(await verifyS256("a".repeat(42) + " ", "x"));
});

Deno.test("pkce: safeEqual compares content and length", () => {
  assertEquals([safeEqual("ab", "ab"), safeEqual("ab", "ac"), safeEqual("ab", "abc")], [true, false, false]);
});
