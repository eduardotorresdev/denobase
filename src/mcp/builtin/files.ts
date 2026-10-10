import { z } from "zod";
import * as engine from "../../engine/mod.ts";
import { notFound } from "../../core/errors.ts";
import { getCollection } from "../../core/registry.ts";
import { signToken } from "../../auth/jwt.ts";
import type { McpHost } from "../host.ts";

/** A download URL for one file of a record the caller may read, with a file token when the field is protected. */
export function fileTools(host: McpHost, p: string): void {
  host.tool({
    name: `${p}file_url`,
    title: "File URL",
    description: "URL to download one file of a record (the record's read rule applies). Protected files get a " +
      "short-lived file token in the URL.",
    annotations: { readOnly: true },
    input: z.object({
      collection: z.string().min(1),
      id: z.string().min(1),
      field: z.string().min(1),
      name: z.string().min(1).describe("The stored file name, as the record's field holds it."),
    }),
    handler: async (a, ctx) => {
      const col = getCollection(a.collection, host.http.collections);
      const field = col.fields.find((f) => f.name === a.field);
      if (!field || field.type !== "file") throw notFound("Missing file field.");
      const doc = await engine.findById({
        collection: col.slug,
        req: engine.makeReq(ctx.app.store, ctx.user),
        id: a.id,
        fields: `id,${field.name}`,
      });
      const v = doc[field.name];
      if (!(Array.isArray(v) ? v.includes(a.name) : v === a.name)) throw notFound("Missing file.");
      const base = (ctx.app.settings.meta.appURL || "http://localhost:8090").replace(/\/+$/, "");
      let url = `${base}/api/files/${encodeURIComponent(col.slug)}/${encodeURIComponent(a.id)}/` +
        encodeURIComponent(a.name);
      if (field.protected && ctx.user) {
        const cred = host.http.s.credentials(ctx.app.db, ctx.user.collection, { id: ctx.user.id });
        if (cred) url += `?token=${await signToken(ctx.user.collection, cred, "file")}`;
      }
      return {
        content: [
          { type: "resource_link" as const, uri: url, name: a.name },
          { type: "text" as const, text: url },
        ],
        structuredContent: { url, protected: !!field.protected },
      };
    },
  });
}
