import type { Context } from "hono";
import type { AccessArgs, AuthUser, Req } from "../core/types.ts";
import { stableForbidden, unauthorized } from "../core/errors.ts";
import { makeReq } from "../engine/mod.ts";
import type { Store } from "../store/mod.ts";
import type { AppEnv } from "./app.ts";

export interface AuthedOptions {
  /** Auth collections allowed to call; unset, any. Superusers always pass this one. */
  collections?: readonly string[];
  /** Permission check, the same shape as a collection access fn (so a consumer's `can(p)` plugs in). */
  allow?: (args: AccessArgs) => boolean | Promise<boolean>;
  /** Message of the 403 when allow refuses. */
  deniedMessage?: string;
}

/** What an authed handler gets besides the Hono context: the principal and a req bound to the app's store. */
export interface AuthedCtx {
  user: AuthUser;
  req: Req;
}

/**
 * Wraps a custom route of a consumer app (auth required + a permission check): 401 PB's message without a valid
 * token, 403 with `data.code = "permissao_negada"` when the collection or `allow` refuses, else runs fn.
 * `app.http.post("/api/x", authed(app, { allow: can("x:create") }, (c, { req }) => ...))`.
 */
export function authed(
  app: { store: Store },
  opts: AuthedOptions,
  fn: (c: Context<AppEnv>, a: AuthedCtx) => Response | Promise<Response>,
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized();
    const req = makeReq(app.store, user);
    const denied = () => stableForbidden(opts.deniedMessage ?? "Você não tem permissão para esta ação.");
    if (opts.collections && !req.isSuperuser && !opts.collections.includes(user.collection)) throw denied();
    if (opts.allow && !(await opts.allow({ req, user }))) throw denied();
    return await fn(c, { user, req });
  };
}
