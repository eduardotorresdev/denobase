import type { CollectionConfig, Doc, Operation, Req } from "../core/types.ts";
import { allFields } from "./fields.ts";
import { traced } from "../telemetry/instrument/child.ts";

/**
 * A `hook <collection>.<phase>` span (or `<collection>.<field>.<phase>`) around a phase's hooks; phases without hooks
 * open none, so traces show only code that ran.
 */
export function traceHook<T>(
  c: CollectionConfig,
  phase: string,
  count: number,
  fn: () => Promise<T>,
  field?: string,
): Promise<T> {
  if (!count) return fn();
  const target = field ? `${c.slug}.${field}` : c.slug;
  return traced(`hook ${target}.${phase}`, {
    attributes: { "denobase.collection": c.slug, "denobase.hook.phase": phase, "denobase.hook.count": count },
  }, fn);
}

/** Field and collection write hooks, in declaration order; a hook returning undefined leaves data as is. */

export async function runFieldHooks(
  req: Req,
  c: CollectionConfig,
  kind: "beforeValidate" | "beforeChange",
  data: Record<string, unknown>,
  operation: Operation,
  originalDoc?: Doc,
): Promise<void> {
  for (const f of allFields(c)) {
    const hooks = f.hooks?.[kind] ?? [];
    await traceHook(c, kind, hooks.length, async () => {
      for (const h of hooks) {
        const v = await h({ req, value: data[f.name], data, originalDoc, operation });
        // Undefined means "no opinion" so a hook can observe without clearing the value.
        if (v !== undefined) data[f.name] = v;
      }
    }, f.name);
  }
}

type CollHook = (a: {
  req: Req;
  collection: CollectionConfig;
  operation: Operation;
  data: Record<string, unknown>;
  originalDoc?: Doc;
}) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export async function runCollHooks(
  req: Req,
  c: CollectionConfig,
  phase: "beforeValidate" | "beforeChange",
  data: Record<string, unknown>,
  operation: Operation,
  originalDoc?: Doc,
): Promise<Record<string, unknown>> {
  const hooks: CollHook[] = c.hooks?.[phase] ?? [];
  return await traceHook(c, phase, hooks.length, async () => {
    for (const h of hooks) data = (await h({ req, collection: c, operation, data, originalDoc })) ?? data;
    return data;
  });
}
