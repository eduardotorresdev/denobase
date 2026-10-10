import bcrypt from "bcrypt";

/** Cost from BCRYPT_COST env (default 10); tests set 4. */
export function bcryptCost(): number {
  return Number(Deno.env.get("BCRYPT_COST") ?? 10);
}
export function hashPassword(plain: string, cost: number = bcryptCost()): Promise<string> {
  return bcrypt.hash(plain, cost);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // Malformed hashes (e.g. empty for OTP-only accounts) must fail closed, not throw.
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
/** Random tokenKey; rotating it invalidates every JWT of the record. */
export function newTokenKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
