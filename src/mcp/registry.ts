import type {
  McpCtx,
  McpPromptDef,
  McpResourceDef,
  McpResourceTemplateDef,
  McpToolDef,
  McpVisibility,
} from "./types.ts";

/** One naming rule for tools, resources, templates and prompts (MCP allows more; we keep it lowercase). */
export const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export type McpKind = "tools" | "resources" | "prompts";

/**
 * Every tool, resource and prompt of the app, built-in or registered by the consumer. Nothing here talks to the
 * protocol: the server factory reads it per request, and a change only tells the listeners (list_changed).
 */
export class McpRegistry {
  readonly tools: Map<string, McpToolDef> = new Map();
  readonly resources: Map<string, McpResourceDef> = new Map();
  readonly templates: Map<string, McpResourceTemplateDef> = new Map();
  readonly prompts: Map<string, McpPromptDef> = new Map();
  readonly #listeners = new Set<(kind: McpKind) => void>();

  onChange(fn: (kind: McpKind) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  addTool(def: McpToolDef): () => void {
    checkName("tool", def.name);
    return this.#add(this.tools, def.name, def, "tools", "tool");
  }

  addResource(def: McpResourceDef): () => void {
    if (!def.uri || !URL.canParse(def.uri)) throw new Error(`mcp: invalid resource uri ${JSON.stringify(def.uri)}`);
    checkName("resource", def.name);
    if (this.resources.has(def.uri)) throw new Error(`mcp: duplicate resource ${def.uri}`);
    if (this.#resourceNameTaken(def.name)) throw new Error(`mcp: duplicate resource name ${def.name}`);
    return this.#add(this.resources, def.uri, def, "resources", "resource");
  }

  addTemplate(def: McpResourceTemplateDef): () => void {
    checkName("resource template", def.name);
    if (!def.uriTemplate.includes("{")) throw new Error(`mcp: resource template ${def.name} has no variable`);
    if (this.#resourceNameTaken(def.name)) throw new Error(`mcp: duplicate resource name ${def.name}`);
    return this.#add(this.templates, def.name, def, "resources", "resource template");
  }

  addPrompt(def: McpPromptDef): () => void {
    checkName("prompt", def.name);
    return this.#add(this.prompts, def.name, def, "prompts", "prompt");
  }

  /** Resources and templates share one name space (both are listed as resources). */
  #resourceNameTaken(name: string): boolean {
    if (this.templates.has(name)) return true;
    for (const r of this.resources.values()) if (r.name === name) return true;
    return false;
  }

  #add<T>(map: Map<string, T>, key: string, def: T, kind: McpKind, what: string): () => void {
    if (map.has(key)) throw new Error(`mcp: duplicate ${what} ${key}`);
    map.set(key, def);
    this.#emit(kind);
    return () => {
      // Only the registration that owns the key removes it: a later re-register under the same name survives.
      if (map.get(key) !== def) return;
      map.delete(key);
      this.#emit(kind);
    };
  }

  #emit(kind: McpKind): void {
    for (const fn of this.#listeners) {
      try {
        fn(kind);
      } catch (e) {
        console.error("mcp list_changed listener failed", e);
      }
    }
  }
}

function checkName(what: string, name: string): void {
  if (!NAME.test(name)) throw new Error(`mcp: invalid ${what} name ${JSON.stringify(name)} (want ${NAME})`);
}

/** Visibility then allow(): what this principal may see, and so call. A throwing allow() hides. */
export async function visible(
  def: { visibility?: McpVisibility; allow?(ctx: McpCtx): boolean | Promise<boolean> },
  ctx: McpCtx,
): Promise<boolean> {
  const v = def.visibility ?? "auth";
  if (!ctx.superuser) {
    if (v === "superuser") return false;
    if (v === "auth" && !ctx.user) return false;
  }
  if (!def.allow) return true;
  try {
    return await def.allow(ctx);
  } catch (e) {
    console.error("mcp allow() failed", e);
    return false;
  }
}

/** Sorted values, so every listing is deterministic. */
export function sorted<T>(map: Map<string, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}
