import type { McpHost } from "../host.ts";
import { adminTools } from "./admin.ts";
import { fileTools } from "./files.ts";
import { healthTool } from "./health.ts";
import { builtinPrompts } from "./prompts.ts";
import { recordTools } from "./records.ts";
import { schemaTools } from "./schema.ts";

/** Groups of built-ins by the name `builtins: [...]` selects them with. */
export const BUILTIN_GROUPS = {
  health: healthTool,
  records: recordTools,
  schema: schemaTools,
  files: fileTools,
  admin: adminTools,
  prompts: builtinPrompts,
} as const;

export type BuiltinGroup = keyof typeof BUILTIN_GROUPS;

/** Registers the built-ins the options ask for (all by default) under the configured prefix. */
export function registerBuiltins(host: McpHost): void {
  const want = host.options.builtins;
  if (want === false) return;
  for (const [name, register] of Object.entries(BUILTIN_GROUPS)) {
    if (want === true || want.includes(name)) register(host, host.options.prefix);
  }
}
