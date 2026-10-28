import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate } from "@modelcontextprotocol/server";
import type { AuthUser } from "../core/types.ts";
import { ApiError } from "../core/errors.ts";
import { makeReq } from "../engine/mod.ts";
import { LEVEL } from "../logs/mod.ts";
import type { McpHost } from "./host.ts";
import { type McpKind, sorted, visible } from "./registry.ts";
import { readsAllowed, toolAllowed } from "../oauth/scopes.ts";
import {
  apiErrorBody,
  apiErrorResult,
  internalErrorResult,
  readContents,
  type ToolResult,
  toolResult,
} from "./result.ts";
import type {
  McpCtx,
  McpPromptDef,
  McpPromptMessage,
  McpReadResult,
  McpResourceTemplateDef,
  McpToolDef,
} from "./types.ts";

export const SERVER_INFO = { name: "denobase", version: "0.2.4" };

const INSTRUCTIONS = "denobase (PocketBase on Deno). Tools run as the authenticated principal: collection access " +
  "rules apply exactly as on the REST API. Start with the collections tool and the schema:// resources.";

/** The ctx of one request (or stdio connection) as `user`; the stores are built here, never by a handler. */
export function mcpContext(
  host: McpHost,
  user: AuthUser | null,
  transport: "http" | "stdio",
  signal: AbortSignal = new AbortController().signal,
  scopes?: string[],
): McpCtx {
  const app = host.app;
  const superuser = user?.collection === "_superusers";
  const tracer = host.tracer;
  return {
    user,
    superuser,
    store: app.store.as(user),
    system: superuser ? app.store : undefined,
    req: makeReq(app.store, user),
    app,
    log: (message, data = {}) =>
      app.logs.add(LEVEL.info, message, { type: "mcp", auth: user?.collection ?? "", authId: user?.id ?? "", ...data }),
    span: tracer ? (name, fn) => tracer.span(name, { transport, auth: user?.collection ?? "" }, fn) : undefined,
    signal,
    transport,
    scopes,
  };
}

/** How a built server is served: the era it speaks and whether it lives across requests (stdio). */
export interface ServeMode {
  era: "legacy" | "modern";
  /** A stdio connection: the server follows registry changes and pushes list_changed itself. */
  live: boolean;
}

/**
 * Whether this server can deliver the list_changed notifications: a live (stdio) connection pushes them on its own
 * channel; a modern HTTP request has the handler's subscriptions/listen bus; a 2025 stateless HTTP request has no
 * stream at all, so it must not claim the capability.
 */
export function canNotify(mode: ServeMode): boolean {
  return mode.live || mode.era === "modern";
}

type Handle = { remove(): void };

/**
 * One McpServer over what ctx's principal may see: invisible definitions are never registered, so calling one is
 * the SDK's unknown-tool error and its existence does not leak. Built per HTTP request (stateless) or per stdio
 * connection; a live (stdio) server re-syncs a kind when the registry changes, and the SDK sends its list_changed.
 */
export async function buildServer(host: McpHost, ctx: McpCtx, mode: ServeMode): Promise<McpServer> {
  const listChanged = canNotify(mode);
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged },
      resources: { listChanged },
      prompts: { listChanged },
      completions: {},
    },
    instructions: INSTRUCTIONS,
  });
  const handles: Record<McpKind, Handle[]> = { tools: [], resources: [], prompts: [] };
  const sync = async (kind: McpKind) => {
    // Decide visibility first (async), then swap with no await in between: a client that lists right after the
    // list_changed always sees the finished set.
    const register = await visibleKind(server, host, ctx, kind);
    for (const h of handles[kind].splice(0)) h.remove();
    handles[kind] = register();
  };
  for (const kind of ["tools", "resources", "prompts"] as const) await sync(kind);
  if (mode.live) {
    // Serialized per server, so two quick changes never interleave their remove/register.
    let chain = Promise.resolve();
    const off = host.registry.onChange((kind) => {
      chain = chain.then(() => sync(kind)).catch((e) => console.error("mcp list sync failed", e));
    });
    const prev = server.server.onclose;
    server.server.onclose = () => {
      off();
      prev?.();
    };
  }
  return server;
}

/** What ctx may see of one kind, decided now; the returned function registers it synchronously. */
async function visibleKind(
  server: McpServer,
  host: McpHost,
  ctx: McpCtx,
  kind: McpKind,
): Promise<() => Handle[]> {
  const reg = host.registry;
  const pick = async <T extends Parameters<typeof visible>[0]>(defs: T[]) => {
    const out: T[] = [];
    for (const def of defs) if (await visible(def, ctx)) out.push(def);
    return out;
  };
  // OAuth scopes narrow what access rules allow, never widen it: filtered after visibility.
  const reads = readsAllowed(ctx.scopes, host.scopes);
  if (kind === "tools") {
    const tools = (await pick(sorted(reg.tools))).filter((def) =>
      toolAllowed({ name: def.name, readOnly: !!def.annotations?.readOnly }, ctx.scopes, host.scopes)
    );
    return () => tools.map((def) => registerTool(server, host, def, ctx));
  }
  if (kind === "prompts") {
    const prompts = reads ? await pick(sorted(reg.prompts)) : [];
    return () => prompts.map((def) => registerPrompt(server, def, ctx));
  }
  const resources = reads ? await pick(sorted(reg.resources)) : [];
  const templates = reads ? await pick(sorted(reg.templates)) : [];
  return () => [
    ...resources.map((def) =>
      server.registerResource(
        def.name,
        def.uri,
        { title: def.title ?? def.name, description: def.description, mimeType: def.mimeType, ...cache(def.ttlMs) },
        async (uri) => readContents(uri.href, await guardRead(uri.href, () => def.read(ctx)), def.mimeType),
      )
    ),
    ...templates.map((def) => registerTemplate(server, def, ctx)),
  ];
}

function registerTemplate(server: McpServer, def: McpResourceTemplateDef, ctx: McpCtx): Handle {
  const complete = def.complete &&
    Object.fromEntries(
      Object.entries(def.complete).map(([k, fn]) => [k, (value: string) => fn(value, ctx)]),
    );
  const list = def.list;
  const template = new ResourceTemplate(def.uriTemplate, {
    list: list ? async () => ({ resources: await list(ctx) }) : undefined,
    ...(complete ? { complete } : {}),
  });
  return server.registerResource(
    def.name,
    template,
    { title: def.title ?? def.name, description: def.description, mimeType: def.mimeType, ...cache(def.ttlMs) },
    async (uri, vars) =>
      readContents(uri.href, await guardRead(uri.href, () => def.read(uri, flatVars(vars), ctx)), def.mimeType),
  );
}

function registerPrompt(server: McpServer, def: McpPromptDef, ctx: McpCtx): Handle {
  const render = async (args: Record<string, unknown>) => {
    const out = await guardPrompt(async () => await def.render(args as never, ctx));
    const messages: McpPromptMessage[] = typeof out === "string"
      ? [{ role: "user", content: { type: "text", text: out } }]
      : out;
    return { description: def.description, messages };
  };
  if (def.args) {
    return server.registerPrompt(
      def.name,
      { title: def.title, description: def.description, argsSchema: def.args },
      (args) => render(args),
    );
  }
  return server.registerPrompt(def.name, { title: def.title, description: def.description }, () => render({}));
}

function cache(ttlMs?: number) {
  return ttlMs ? { cacheHint: { ttlMs, cacheScope: "private" as const } } : {};
}

function flatVars(vars: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
}

/**
 * An ApiError of a resource read as a JSON-RPC error with the same body tools put in isError (code, status, message,
 * data) plus the uri: 404 (and 403, which access answers for what the caller may not see) is resource not found
 * (the SDK sends it as -32602 with data.uri, the 2026-07-28 rule), 400 is invalid params, the rest internal.
 */
async function guardRead(uri: string, fn: () => Promise<McpReadResult>): Promise<McpReadResult> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const data = { uri, ...apiErrorBody(e) };
    if (e.status === 404 || e.status === 403) {
      throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, e.message, data);
    }
    throw new ProtocolError(
      e.status === 400 ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError,
      e.message,
      data,
    );
  }
}

/** The same contract for prompts: a 4xx is the caller's arguments (invalid params), the rest internal. */
async function guardPrompt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const code = e.status < 500 ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError;
    throw new ProtocolError(code, e.message, apiErrorBody(e));
  }
}

function registerTool(server: McpServer, host: McpHost, def: McpToolDef, ctx: McpCtx): Handle {
  const a = def.annotations ?? {};
  return server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      ...(def.output ? { outputSchema: def.output } : {}),
      annotations: {
        title: def.title,
        readOnlyHint: a.readOnly,
        destructiveHint: a.destructive,
        idempotentHint: a.idempotent,
        openWorldHint: a.openWorld,
      },
    },
    (args) => runTool(host, def, args as Record<string, unknown>, ctx) as Promise<never>,
  );
}

/** Runs one call: timeout, optional span, the tool's own _logs line, ApiError as isError. */
export async function runTool(
  host: McpHost,
  def: McpToolDef,
  args: Record<string, unknown>,
  base: McpCtx,
): Promise<ToolResult> {
  const timeout = AbortSignal.timeout(host.options.toolTimeoutMs);
  const ctx: McpCtx = { ...base, signal: AbortSignal.any([base.signal, timeout]) };
  const started = performance.now();
  let result: ToolResult;
  let error: string | undefined;
  try {
    const call = () => def.handler(args as never, ctx);
    const run = ctx.span ? ctx.span(`mcp.tool ${def.name}`, call) : call();
    const value = await Promise.race([run, aborted(ctx.signal)]);
    result = toolResult(value, host.options.maxResultBytes, !!def.output);
  } catch (e) {
    if (e instanceof ApiError) result = apiErrorResult(e);
    else if (timeout.aborted) {
      // Promise.race cannot stop the handler: say so, so the model checks state before retrying a write.
      result = internalErrorResult(
        `Tool did not finish within ${host.options.toolTimeoutMs} ms. It was signalled to stop but may still ` +
          "complete: check the current state before retrying.",
        "tempo_esgotado",
      );
    } else {
      error = e instanceof Error ? e.message : String(e);
      console.error(`mcp tool ${def.name} failed`, e);
      result = internalErrorResult();
    }
  }
  try {
    base.app.logs.add(
      error ? LEVEL.error : LEVEL.info,
      `MCP ${def.name}`,
      {
        type: "mcp",
        tool: def.name,
        transport: base.transport,
        execTime: performance.now() - started,
        isError: !!result.isError,
        auth: base.user?.collection ?? "",
        authId: base.user?.id ?? "",
        ...(error ? { error } : {}),
      },
      host.app.settings.logs.maxDataSize,
    );
  } catch (e) {
    console.error("mcp log failed", e);
  }
  return result;
}

/** Rejects on abort; pre-handled so losing the race never surfaces as an unhandled rejection. */
function aborted(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  p.catch(() => {});
  return p;
}
