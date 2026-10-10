import { z } from "zod";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { App } from "../app.ts";
import type { AuthUser } from "../core/types.ts";
import type { Ctx } from "../http/app.ts";
import { signToken } from "../auth/jwt.ts";
import { badRequest } from "../core/errors.ts";
import { getCollection } from "../core/registry.ts";
import { McpRegistry, NAME } from "./registry.ts";
import { buildServer, mcpContext } from "./server.ts";
import type {
  Mcp,
  McpGroup,
  McpListing,
  McpOptions,
  McpPromptDef,
  McpRegistrar,
  McpToolDef,
  McpTracer,
  ResolvedMcpOptions,
} from "./types.ts";
import { registerBuiltins } from "./builtin/mod.ts";
import { resolveOAuthOptions } from "../oauth/options.ts";
import { scopeRegistry } from "../oauth/scopes.ts";
import type { OAuthScope } from "../oauth/types.ts";

export const MCP_PATH = "/api/mcp";

export function resolveMcpOptions(o: McpOptions = {}): ResolvedMcpOptions {
  return {
    enabled: o.enabled ?? true,
    prefix: o.prefix ?? "db_",
    allowedOrigins: o.allowedOrigins ?? [],
    requireAudience: o.requireAudience ?? true,
    allowGuest: o.allowGuest ?? false,
    maxResultBytes: o.maxResultBytes ?? 256 * 1024,
    toolTimeoutMs: o.toolTimeoutMs ?? 30_000,
    builtins: o.builtins ?? true,
    oauth: resolveOAuthOptions(o.oauth),
  };
}

/**
 * The app's MCP: the registry (the extension API, app.mcp), the HTTP handler over it and what the factory needs
 * of the app. createApp builds it before the routes and attaches the finished app after.
 */
export class McpHost implements Mcp {
  readonly registry: McpRegistry = new McpRegistry();
  readonly options: ResolvedMcpOptions;
  /** The OAuth scopes (built-ins and the app's): which tools a token's scopes open. */
  readonly scopes: Map<string, OAuthScope>;
  tracer?: McpTracer;
  #app?: App;
  #ctx?: Ctx;
  #handler?: McpHttpHandler;
  #unTraces?: () => void;

  constructor(opts: McpOptions = {}) {
    this.options = resolveMcpOptions(opts);
    this.scopes = scopeRegistry(this.options.oauth.scopes);
    // HTTP: list_changed reaches 2026-07-28 clients through their subscriptions/listen streams on the handler's bus.
    // stdio connections follow the registry themselves (buildServer, live).
    this.registry.onChange((kind) => {
      const n = this.#handler?.notify;
      if (!n) return;
      if (kind === "tools") n.toolsChanged();
      else if (kind === "resources") n.resourcesChanged();
      else n.promptsChanged();
    });
  }

  get app(): App {
    if (!this.#app) throw new Error("mcp: app not attached yet");
    return this.#app;
  }

  /** The HTTP layer's ctx: the collections the app serves and the settings hooks the admin tools need. */
  get http(): Ctx {
    if (!this.#ctx) throw new Error("mcp: app not attached yet");
    return this.#ctx;
  }

  /** Called once by createApp, with the finished app; registers the built-ins. */
  attach(app: App, ctx: Ctx): void {
    this.#app = app;
    this.#ctx = ctx;
    registerBuiltins(this);
  }

  /** The Streamable HTTP handler (both protocol eras), built on first use. */
  get handler(): McpHttpHandler {
    return this.#handler ??= createMcpHandler(
      (rc) => {
        const user = (rc.authInfo?.extra?.user ?? null) as AuthUser | null;
        const scopes = rc.authInfo?.extra?.scopes as string[] | undefined;
        return buildServer(this, mcpContext(this, user, "http", rc.requestInfo?.signal, scopes), {
          era: rc.era,
          live: false,
        });
      },
      {
        legacy: "stateless",
        maxRequestBodySize: 1024 * 1024,
        onerror: (e) => console.error("mcp", e.message),
      },
    );
  }

  async close(): Promise<void> {
    await this.#handler?.close();
  }

  tool: Mcp["tool"] = (def) => this.registry.addTool(def as unknown as McpToolDef);
  resource: Mcp["resource"] = (def) => this.registry.addResource(def);
  resourceTemplate: Mcp["resourceTemplate"] = (def) => this.registry.addTemplate(def);
  prompt: Mcp["prompt"] = (def) => this.registry.addPrompt(def as unknown as McpPromptDef);

  group(prefix: string): McpGroup {
    if (!/^[a-z][a-z0-9]*_$/.test(prefix)) throw new Error(`mcp: invalid group prefix ${JSON.stringify(prefix)}`);
    if (prefix === this.options.prefix) throw new Error(`mcp: group prefix ${prefix} is the built-ins' prefix`);
    const offs: (() => void)[] = [];
    const named = <T extends { name: string }>(def: T): T => {
      const name = `${prefix}${def.name}`;
      if (!NAME.test(name)) throw new Error(`mcp: invalid name ${JSON.stringify(name)} (want ${NAME})`);
      return { ...def, name };
    };
    const keep = (off: () => void) => {
      offs.push(off);
      return off;
    };
    const reg: McpRegistrar = {
      tool: (def) => keep(this.tool(named(def))),
      resource: (def) => keep(this.resource(named(def))),
      resourceTemplate: (def) => keep(this.resourceTemplate(named(def))),
      prompt: (def) => keep(this.prompt(named(def))),
    };
    return { ...reg, prefix, off: () => offs.splice(0).forEach((off) => off()) };
  }

  list(): McpListing {
    const keys = (m: Map<string, unknown>) => [...m.keys()].sort();
    const r = this.registry;
    return {
      tools: keys(r.tools),
      resources: keys(r.resources),
      resourceTemplates: [...r.templates.values()].map((t) => t.uriTemplate).sort(),
      prompts: keys(r.prompts),
    };
  }

  useTracer(tracer: McpTracer): void {
    this.tracer = tracer;
    this.#unTraces?.();
    this.#unTraces = undefined;
    const query = tracer.query?.bind(tracer);
    if (!query) return;
    this.#unTraces = this.tool({
      name: `${this.options.prefix}traces`,
      description: "Recent traces from the plugged telemetry provider.",
      visibility: "superuser",
      annotations: { readOnly: true },
      input: zTraces(),
      handler: (args) => query({ limit: args.limit ?? 50, filter: args.filter }),
    });
  }

  async token(collection: string, id: string, opts: { ttl?: number; baseURL?: string } = {}): Promise<string> {
    // The same base http.ts checks against: appURL, else the URL the client will call (no guessed localhost).
    const base = this.app.settings.meta.appURL || opts.baseURL;
    if (!base) throw badRequest("Set settings.meta.appURL (or pass baseURL) to mint an MCP token.");
    const col = getCollection(collection, this.http.collections);
    const cred = this.http.s.credentials(this.app.db, col.slug, { id });
    if (!cred) throw badRequest("Missing auth record.");
    return await signToken(col.slug, cred, "auth", { ttl: opts.ttl, refreshable: false, aud: mcpResource(base) });
  }
}

/** The RFC 8707 resource id of this server: <base>/api/mcp (base without a trailing slash). */
export function mcpResource(base: string): string {
  return `${base.replace(/\/+$/, "")}${MCP_PATH}`;
}

function zTraces() {
  return z.object({
    limit: z.number().int().min(1).max(500).optional(),
    filter: z.string().optional(),
  });
}
