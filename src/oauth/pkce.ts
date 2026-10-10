/** Secrets of the authorization server: random values, hashes and constant-time comparison. */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: codes, refresh tokens, session ids, txn ids, client ids and secrets. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 hex: what is stored for every bearer secret, so a db leak hands out nothing usable. */
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant time over the longer input, so neither content nor length leaks by timing. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** RFC 7636 §4.1 verifier charset and length. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge. plain is never accepted. */
export async function verifyS256(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER.test(verifier)) return false;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return safeEqual(b64url(d), challenge);
}
