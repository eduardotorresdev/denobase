import { z } from "zod";
import * as engine from "../../engine/mod.ts";
import { notFound } from "../../core/errors.ts";
import { getCollection } from "../../core/registry.ts";
import { type CollectionConfig, LOCKED } from "../../core/types.ts";
import { exportCollection } from "../../collections/export.ts";
import type { McpHost } from "../host.ts";
import type { McpCtx } from "../types.ts";

/** A collection the principal may list: superuser, or a read rule that is not a flat deny (PB nil rule = deny). */
export async function readable(c: CollectionConfig, ctx: McpCtx): Promise<boolean> {
  if (ctx.superuser) return true;
  const fn = c.access?.read;
  if (!fn || fn === LOCKED) return false;
  const r = await fn({ req: engine.makeReq(ctx.app.store, ctx.user), user: ctx.user });
  return r !== false && r !== LOCKED;
}

const kind = (c: CollectionConfig) => (c.view ? "view" : c.auth ? "auth" : "base");

/** What a non-superuser learns of a collection: name, type and the fields it can see (hidden ones never). */
function summary(c: CollectionConfig) {
  return {
    name: c.slug,
    type: kind(c),
    fields: c.fields.filter((f) => !f.hidden).map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(f.type === "select" ? { options: f.options, ...(f.hasMany ? { hasMany: true } : {}) } : {}),
      ...(f.type === "relationship" ? { relationTo: f.relationTo, ...(f.hasMany ? { hasMany: true } : {}) } : {}),
    })),
  };
}

/** The collections tool and the schema://, record:// resources. */
export function schemaTools(host: McpHost, p: string): void {
  const all = () => host.http.collections;
  const visibleCollections = async (ctx: McpCtx) => {
    const out: CollectionConfig[] = [];
    for (const c of [...all()].sort((a, b) => a.slug.localeCompare(b.slug))) if (await readable(c, ctx)) out.push(c);
    return out;
  };
  const one = async (name: string, ctx: McpCtx, full: boolean) => {
    let c: CollectionConfig;
    try {
      c = getCollection(name, all());
    } catch {
      throw notFound("Missing collection context.");
    }
    if (!(await readable(c, ctx))) throw notFound("Missing collection context.");
    return full && ctx.superuser ? exportCollection(c, all()) : summary(c);
  };

  host.tool({
    name: `${p}collections`,
    title: "Collections",
    description: "Without name: the collections the caller may read (name, type, field count). With name: its " +
      "fields; full=true (superuser only) gives the PocketBase JSON with rules and indexes.",
    annotations: { readOnly: true, idempotent: true },
    input: z.object({
      name: z.string().optional(),
      full: z.boolean().optional().describe("Superuser only: PB export JSON."),
    }),
    handler: async (a, ctx) => {
      if (a.name) return await one(a.name, ctx, !!a.full);
      const items = (await visibleCollections(ctx)).map((c) => ({
        name: c.slug,
        type: kind(c),
        fields: c.fields.filter((f) => !f.hidden).length,
      }));
      return { items };
    },
  });

  host.resource({
    uri: "schema://collections",
    name: "collections",
    title: "Collections",
    description: "The collections the caller may read, with their visible fields.",
    mimeType: "application/json",
    ttlMs: 60_000,
    read: async (ctx) => ({ items: (await visibleCollections(ctx)).map(summary) }),
  });

  host.resourceTemplate({
    name: "collection_schema",
    uriTemplate: "schema://collections/{name}",
    title: "Collection schema",
    description: "One collection: visible fields; the PB JSON (rules, indexes, hidden fields) for a superuser.",
    mimeType: "application/json",
    ttlMs: 60_000,
    list: async (ctx) =>
      (await visibleCollections(ctx)).map((c) => ({
        uri: `schema://collections/${c.slug}`,
        name: c.slug,
        mimeType: "application/json",
      })),
    complete: {
      name: async (value, ctx) => (await visibleCollections(ctx)).map((c) => c.slug).filter((s) => s.startsWith(value)),
    },
    read: (_uri, vars, ctx) => one(vars.name, ctx, true),
  });

  host.resourceTemplate({
    name: "record",
    uriTemplate: "record://{collection}/{id}",
    title: "Record",
    description: "One record, read as the caller (access rules apply).",
    mimeType: "application/json",
    read: (_uri, vars, ctx) =>
      engine.findById({
        collection: getCollection(vars.collection, all()).slug,
        req: engine.makeReq(ctx.app.store, ctx.user),
        id: vars.id,
      }),
  });
}
