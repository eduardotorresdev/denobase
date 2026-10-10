import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.ts";
import type { AuthUser } from "../core/types.ts";
import { forbidden, unauthorized } from "../core/errors.ts";

/** PB RequireSuperuserAuth: 401 without auth, 403 for any other auth collection. */
export function requireSuperuser(c: Context<AppEnv>): AuthUser {
  const user = c.get("user");
  if (!user) throw unauthorized("The request requires superuser authorization token.");
  if (user.collection !== "_superusers") {
    throw forbidden("The authorized record is not allowed to perform this action.");
  }
  return user;
}

/** requireSuperuser as route middleware. */
export const superuser: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireSuperuser(c);
  await next();
};
