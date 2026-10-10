import type { CollectionConfig, Doc } from "../core/types.ts";
import { hashPassword, newTokenKey, verifyPassword } from "../auth/password.ts";
import { failed } from "./validate.ts";

export const MIN_PASSWORD = 8;

/**
 * Turns plain password input into stored auth columns before hooks run, so guardUserCargo sees a passwordHash
 * change. Clients never write passwordHash/tokenKey directly; tokenKey rotates on password or email change.
 * Without manage access (PB manageRule) email and verified cannot be set and a password change needs oldPassword.
 */
export async function authInput(
  c: CollectionConfig,
  input: Record<string, unknown>,
  op: "create" | "update",
  override: boolean,
  original?: Doc,
  manage = override,
): Promise<Record<string, unknown>> {
  if (!c.auth) return input;
  const { password, passwordConfirm, oldPassword, ...data } = input;
  if (!override) {
    delete data.passwordHash;
    delete data.tokenKey;
  }
  const sent = password !== undefined && password !== "";
  if (op === "create" && !sent && !data.passwordHash) {
    throw failed(op, { password: { code: "validation_required", message: "Cannot be blank." } });
  }
  if (sent) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw failed(op, {
        password: { code: "validation_length_out_of_range", message: `Must be at least ${MIN_PASSWORD} characters.` },
      });
    }
    if (passwordConfirm !== password) {
      throw failed(op, { passwordConfirm: { code: "validation_values_mismatch", message: "Values don't match." } });
    }
    if (op === "update" && !manage) {
      const ok = typeof oldPassword === "string" && oldPassword !== "" &&
        await verifyPassword(oldPassword, String(original?.passwordHash ?? ""));
      if (!ok) {
        throw failed(op, {
          oldPassword: { code: "validation_invalid_old_password", message: "Missing or invalid old password." },
        });
      }
    }
    data.passwordHash = await hashPassword(password);
  }
  const emailChanged = op === "update" && "email" in data && data.email !== original?.email;
  if (!manage) {
    if (emailChanged) {
      throw failed(op, {
        email: { code: "validation_email_change_forbidden", message: "Use request-email-change to change the email." },
      });
    }
    const verifiedSet = "verified" in data &&
      (op === "create" ? !!data.verified : !!data.verified !== !!original?.verified);
    if (verifiedSet) {
      throw failed(op, { verified: { code: "validation_forbidden", message: "Only managers can change verified." } });
    }
  }
  if (op === "create" ? !data.tokenKey : sent || emailChanged) data.tokenKey = newTokenKey();
  return data;
}
