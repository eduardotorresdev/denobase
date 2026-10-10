import type { DatabaseSync } from "node:sqlite";
import * as engine from "../engine/mod.ts";
import * as auth from "../auth/mod.ts";
import { quoteIdent, tableName } from "../schema/mod.ts";
import type { AuthUser } from "../core/types.ts";

/** Raw credentials row; read with SQL because the engine strips hidden fields. */
export interface Credentials {
  id: string;
  passwordHash: string;
  tokenKey: string;
}

/** Collaborators the HTTP layer calls; injectable so route tests do not need the real engine/auth. */
export interface Services {
  find: typeof engine.find;
  findById: typeof engine.findById;
  create: typeof engine.create;
  update: typeof engine.update;
  remove: typeof engine.remove;
  makeReq: typeof engine.makeReq;
  verifyAuthToken: (db: DatabaseSync, token: string) => Promise<AuthUser | null>;
  signAuthToken: typeof auth.signAuthToken;
  verifyPassword: typeof auth.verifyPassword;
  requestOtp: typeof auth.requestOtp;
  verifyOtp: typeof auth.verifyOtp;
  credentials: (db: DatabaseSync, slug: string, by: { email?: string; id?: string }) => Credentials | null;
}

function credentials(db: DatabaseSync, slug: string, by: { email?: string; id?: string }): Credentials | null {
  const col = by.email !== undefined ? "email" : "id";
  const row = db.prepare(
    `SELECT id, passwordHash, tokenKey FROM ${quoteIdent(tableName(slug))} WHERE ${quoteIdent(col)} = ? LIMIT 1`,
  ).get(by.email ?? by.id ?? "");
  return row ? (row as unknown as Credentials) : null;
}

export const defaultServices: Services = {
  find: engine.find,
  findById: engine.findById,
  create: engine.create,
  update: engine.update,
  remove: engine.remove,
  makeReq: engine.makeReq,
  verifyAuthToken: auth.verifyAuthToken,
  signAuthToken: auth.signAuthToken,
  verifyPassword: auth.verifyPassword,
  requestOtp: auth.requestOtp,
  verifyOtp: auth.verifyOtp,
  credentials,
};
