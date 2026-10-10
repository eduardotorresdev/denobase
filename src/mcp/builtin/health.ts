import { z } from "zod";
import type { McpHost } from "../host.ts";

/** Liveness and who the server thinks the caller is (useful to check a token). */
export function healthTool(host: McpHost, p: string): void {
  host.tool({
    name: `${p}health`,
    title: "Health",
    description: "Is the server up, and as whom is this session authenticated.",
    visibility: "any",
    annotations: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler: (_a, ctx) =>
      Promise.resolve({
        message: "API is healthy.",
        code: 200,
        auth: ctx.user ? { collection: ctx.user.collection, id: ctx.user.id, superuser: ctx.superuser } : null,
        transport: ctx.transport,
        canBackup: ctx.superuser ? !!ctx.app.backups : undefined,
      }),
  });
}
