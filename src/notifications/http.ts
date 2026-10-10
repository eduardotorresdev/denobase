import type { Context, Hono } from "hono";
import { z } from "zod";
import { renderSVG } from "uqr";
import type { AppEnv } from "../http/app.ts";
import { requireSuperuser } from "../http/guards.ts";
import type { AuthUser } from "../core/types.ts";
import { badRequest, forbidden, unauthorized } from "../core/errors.ts";
import type { Store } from "../store/mod.ts";
import { NOTIFICATION_STATUS, notificationsCollection as notifications } from "./schema.ts";
import type { Notifications } from "./registry.ts";
import { WHATSAPP_WEB, type WhatsAppWebProvider } from "./whatsapp/provider.ts";

/** What a route does, so a consumer can open some of them (e.g. "send") to its own users. */
export type NotificationAction =
  | "send"
  | "list"
  | "retry"
  | "providers"
  | "configure"
  | "whatsapp.pair"
  | "whatsapp.logout"
  | "whatsapp.groups"
  | "whatsapp.check"
  | "whatsapp.presence";

/** true lets the request through; the default lets superusers only. */
export type NotificationAuthorize = (user: AuthUser | null, action: NotificationAction) => boolean | Promise<boolean>;

const superuserOnly: NotificationAuthorize = (user) => user?.collection === "_superusers";

async function guard(c: Context<AppEnv>, authorize: NotificationAuthorize, action: NotificationAction): Promise<void> {
  const user = c.get("user");
  if (authorize === superuserOnly) return void requireSuperuser(c);
  if (await authorize(user, action)) return;
  if (!user) throw unauthorized();
  throw forbidden();
}

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw badRequest("Invalid JSON body.");
  });
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? "Invalid body.");
  return r.data;
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(500).default(30),
  status: z.enum(NOTIFICATION_STATUS).optional(),
  provider: z.string().optional(),
});

/** /api/notifications/*: send, send log, provider status/config and the WhatsApp Web session. */
export function notificationRoutes(
  app: Hono<AppEnv>,
  store: Store,
  n: Notifications,
  authorize: NotificationAuthorize = superuserOnly,
): void {
  const g = (action: NotificationAction) => (c: Context<AppEnv>) => guard(c, authorize, action);
  const whatsapp = () => n.get(WHATSAPP_WEB) as WhatsAppWebProvider;

  app.get("/api/notifications/providers", async (c) => {
    await g("providers")(c);
    const list = await Promise.all(n.list().map(async (p) => ({ ...p, enabled: await n.isEnabled(p.id) })));
    return c.json(list);
  });

  app.patch("/api/notifications/providers/:id", async (c) => {
    await g("configure")(c);
    const patch = await body(
      c,
      z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }),
    );
    await n.configure(c.req.param("id"), patch);
    return c.body(null, 204);
  });

  app.post("/api/notifications/send", async (c) => {
    await g("send")(c);
    return c.json(await n.send(await body(c, z.unknown()) as never));
  });

  app.get("/api/notifications", async (c) => {
    await g("list")(c);
    const r = listQuery.safeParse(c.req.query());
    if (!r.success) throw badRequest(r.error.issues[0]?.message ?? "Invalid query.");
    const { page, perPage, status, provider } = r.data;
    let q = store.collection(notifications).query();
    if (status) q = q.where("status", "equals", status);
    if (provider) q = q.where("provider", "equals", provider);
    const totalItems = await q.count();
    const items = await q.orderBy("created", "desc").limit(perPage).offset((page - 1) * perPage).all();
    return c.json({ page, perPage, totalItems, totalPages: Math.ceil(totalItems / perPage), items });
  });

  app.post("/api/notifications/:id/retry", async (c) => {
    await g("retry")(c);
    return c.json(await n.retry(c.req.param("id")));
  });

  app.get("/api/notifications/whatsapp/status", async (c) => {
    await g("whatsapp.pair")(c);
    const s = whatsapp().status();
    // The QR rendered here so the admin UI (and any consumer screen) needs no QR library of its own.
    return c.json(s.qr ? { ...s, qrSvg: renderSVG(s.qr) } : s);
  });

  app.post("/api/notifications/whatsapp/logout", async (c) => {
    await g("whatsapp.logout")(c);
    await whatsapp().logout();
    return c.body(null, 204);
  });

  app.get("/api/notifications/whatsapp/groups", async (c) => {
    await g("whatsapp.groups")(c);
    return c.json(await whatsapp().groups());
  });

  app.post("/api/notifications/whatsapp/check", async (c) => {
    await g("whatsapp.check")(c);
    const { numbers } = await body(c, z.object({ numbers: z.array(z.string().min(1)).min(1).max(50) }));
    return c.json(await whatsapp().isOnWhatsApp(numbers));
  });

  app.post("/api/notifications/whatsapp/presence", async (c) => {
    await g("whatsapp.presence")(c);
    const p = await body(
      c,
      z.object({
        to: z.string().min(1),
        type: z.enum(["available", "unavailable", "composing", "recording", "paused"]),
      }),
    );
    await whatsapp().presence(p.to, p.type);
    return c.body(null, 204);
  });
}
