import { z } from "zod";
import * as engine from "../../engine/mod.ts";
import { tx } from "../../core/db.ts";
import { ApiError, badRequest, forbidden } from "../../core/errors.ts";
import { getCollection } from "../../core/registry.ts";
import type { McpHost } from "../host.ts";
import type { McpCtx } from "../types.ts";
import { errorCode } from "../result.ts";

export const MAX_PER_PAGE = 200;

const collection = z.string().min(1).describe("Collection name (slug), e.g. from the collections tool.");
const expand = z.string().optional().describe("PB expand: relation fields to inline, e.g. 'cliente,itens.produto'.");
const fields = z.string().optional().describe("PB fields: comma list of fields to return, e.g. 'id,nome,expand.x'.");
const data = z.record(z.string(), z.unknown()).describe("Field values; validated like the REST API.");

/** A Req per operation (its context bag is per write), as the principal of ctx. */
const req = (ctx: McpCtx) => engine.makeReq(ctx.app.store, ctx.user);

/** Record CRUD and batch through the engine as the principal: the REST API's rules, filters and hooks. */
export function recordTools(host: McpHost, p: string): void {
  const slug = (name: string) => getCollection(name, host.http.collections).slug;

  host.tool({
    name: `${p}list`,
    title: "List records",
    description: "List records of a collection with PocketBase filter/sort/expand/fields and paging. " +
      "Only records the caller may read come back (collection access rules apply).",
    annotations: { readOnly: true, idempotent: true },
    input: z.object({
      collection,
      filter: z.string().optional().describe("PB filter, e.g. \"status = 'aberto' && created >= '2026-01-01'\"."),
      sort: z.string().optional().describe("PB sort, e.g. '-created,nome'."),
      expand,
      fields,
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(MAX_PER_PAGE).optional().describe(`Default 30, max ${MAX_PER_PAGE}.`),
      skipTotal: z.boolean().optional().describe("Skip the COUNT (totalItems/totalPages come back as -1)."),
    }),
    handler: (a, ctx) =>
      engine.find({
        collection: slug(a.collection),
        req: req(ctx),
        filter: a.filter || undefined,
        sort: a.sort || undefined,
        expand: a.expand || undefined,
        fields: a.fields || undefined,
        page: a.page ?? 1,
        perPage: a.perPage ?? 30,
        skipTotal: a.skipTotal,
      }),
  });

  host.tool({
    name: `${p}get`,
    title: "Get record",
    description: "One record by id, if the caller may read it.",
    annotations: { readOnly: true, idempotent: true },
    input: z.object({ collection, id: z.string().min(1), expand, fields }),
    handler: (a, ctx) =>
      engine.findById({
        collection: slug(a.collection),
        req: req(ctx),
        id: a.id,
        expand: a.expand || undefined,
        fields: a.fields || undefined,
      }),
  });

  host.tool({
    name: `${p}create`,
    title: "Create record",
    description: "Create a record (hooks, validation and the collection's create rule apply).",
    annotations: { destructive: false },
    input: z.object({ collection, data, expand, fields }),
    handler: (a, ctx) =>
      engine.create({
        collection: slug(a.collection),
        req: req(ctx),
        data: a.data,
        expand: a.expand || undefined,
        fields: a.fields || undefined,
      }),
  });

  host.tool({
    name: `${p}update`,
    title: "Update record",
    description: "Patch a record: only the given fields change (the update rule applies).",
    annotations: { destructive: true, idempotent: true },
    input: z.object({ collection, id: z.string().min(1), data, expand, fields }),
    handler: (a, ctx) =>
      engine.update({
        collection: slug(a.collection),
        req: req(ctx),
        id: a.id,
        data: a.data,
        expand: a.expand || undefined,
        fields: a.fields || undefined,
      }),
  });

  host.tool({
    name: `${p}delete`,
    title: "Delete record",
    description: "Delete a record (the delete rule applies; cascades like the REST API).",
    annotations: { destructive: true, idempotent: true },
    input: z.object({ collection, id: z.string().min(1) }),
    handler: async (a, ctx) => {
      await engine.remove({ collection: slug(a.collection), req: req(ctx), id: a.id });
      return { deleted: true, collection: a.collection, id: a.id };
    },
  });

  host.tool({
    name: `${p}batch`,
    title: "Batch writes",
    description: "Several creates/updates/upserts/deletes in one transaction: all or nothing. Needs batch " +
      "enabled in settings; at most settings.batch.maxRequests operations.",
    annotations: { destructive: true },
    input: z.object({
      requests: z.array(z.object({
        action: z.enum(["create", "update", "upsert", "delete"]),
        collection,
        id: z.string().optional().describe("Required for update and delete; upsert updates when it exists."),
        data: data.optional(),
      })).min(1),
    }),
    handler: async (a, ctx) => {
      const cfg = ctx.app.settings.batch;
      if (!cfg.enabled || cfg.maxRequests <= 0) throw forbidden("Batch requests are not allowed.");
      if (a.requests.length > cfg.maxRequests) {
        throw badRequest(`At most ${cfg.maxRequests} requests per batch.`);
      }
      let failed = -1;
      try {
        const results = await tx(ctx.app.db, async () => {
          const out: unknown[] = [];
          for (const [i, r] of a.requests.entries()) {
            failed = i;
            out.push(await batchOne(r, slug(r.collection), ctx));
          }
          return out;
        });
        return { results };
      } catch (e) {
        if (!(e instanceof ApiError) || failed < 0) throw e;
        throw badRequest(
          "Batch transaction failed.",
          {
            requests: {
              [String(failed)]: { code: errorCode(e), message: e.message, response: e.toJSON() },
            },
          } as unknown as ApiError["data"],
        );
      }
    },
  });
}

async function batchOne(
  r: { action: "create" | "update" | "upsert" | "delete"; id?: string; data?: Record<string, unknown> },
  collection: string,
  ctx: McpCtx,
): Promise<unknown> {
  const data = r.data ?? {};
  const needId = () => {
    if (!r.id) throw badRequest(`${r.action} needs an id.`);
    return r.id;
  };
  switch (r.action) {
    case "create":
      return await engine.create({ collection, req: req(ctx), data: r.id ? { ...data, id: r.id } : data });
    case "update":
      return await engine.update({ collection, req: req(ctx), id: needId(), data });
    case "upsert": {
      // PB's PUT: an existing id updates, anything else creates with it. Existence is checked as the caller, so a
      // record it cannot read answers like a create (what REST create says too), never an update's rule error.
      const exists = r.id && await ctx.store.collection(collection).findOne(r.id);
      return exists
        ? await engine.update({ collection, req: req(ctx), id: r.id!, data })
        : await engine.create({ collection, req: req(ctx), data: r.id ? { ...data, id: r.id } : data });
    }
    case "delete":
      await engine.remove({ collection, req: req(ctx), id: needId() });
      return { deleted: true, id: r.id };
  }
}
