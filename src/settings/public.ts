import type { Settings } from "./model.ts";

/** PB Settings.MarshalJSON: secrets never leave the server (smtp.password and the s3 secrets are omitted). */
export function publicSettings(s: Settings): Record<string, unknown> {
  const out = structuredClone(s) as unknown as Record<string, Record<string, unknown>>;
  delete out.smtp.password;
  delete out.s3.secret;
  delete (out.backups.s3 as Record<string, unknown>).secret;
  return out;
}
