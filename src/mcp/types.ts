import type { z } from "zod";
import type { App } from "../app.ts";
import type { AuthUser, Req } from "../core/types.ts";
import type { Store } from "../store/mod.ts";
import type { OAuthOptions, ResolvedOAuthOptions } from "../oauth/types.ts";

/** Who may see (and so call) a tool, resource or prompt; superuser always passes. */
export type McpVisibility = "any" | "auth" | "superuser";

/** What every handler gets: the principal and the store acting as it, so access rules apply like the REST API. */
export interface McpCtx {
  user: AuthUser | null;
  superuser: boolean;
  /** app.store.as(user): access rules, field access and hidden fields exactly as on REST. */
  store: Store;
  /** The system store (no access rules); only set for a superuser. */
  system?: Store;
  /** makeReq(app.store, user), for engine calls that take a Req. */
  req: Req;
  app: App;
  /** Writes one line to the app logs (`_logs`), tagged with the principal. */
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Present when a tracer was plugged with app.mcp.useTracer. */
  span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Aborts when the call times out or the client goes away. */
  signal: AbortSignal;
  transport: "http" | "stdio";
  /** OAuth scopes of the token (src/oauth); undefined (stdio, app.mcp.token) means no scope narrowing. */
  scopes?: string[];
}

/** MCP tool annotations (hints for the client, never a security boundary). */
export interface McpAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

/** Explicit MCP content, returned as is instead of the JSON of a plain object. */
export interface McpContent {
  content: (
    | { type: "text"; text: string }
    | { type: "image" | "audio"; data: string; mimeType: string }
    | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string }
  )[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Guarded {
  /** Default "auth": any authenticated principal. */
  visibility?: McpVisibility;
  /**
   * Extra per-principal check after visibility; false hides the definition from this principal. It may be async
   * (a permission held in the db): it runs once per HTTP request, and once per stdio connection or registry change.
   */
  allow?(ctx: McpCtx): boolean | Promise<boolean>;
}

/** Any zod object schema: tool input and tool output are always objects. */
type AnyObject = z.ZodObject;

/** MCP prompt arguments are strings on the wire: each field must accept a string (optional allowed). */
export type McpPromptArgs = z.ZodObject<Record<string, z.ZodType<string | undefined, string | undefined>>>;

export interface McpToolDef<I extends AnyObject = AnyObject, O extends AnyObject | undefined = undefined>
  extends Guarded {
  /** /^[a-z][a-z0-9_]{0,63}$/, unique across the registry. */
  name: string;
  title?: string;
  description: string;
  input: I;
  /**
   * Declared output (an object schema): the handler's return is typed by it, becomes structuredContent and the SDK
   * validates it. Recommended for every read tool, so the contract is typed end to end.
   */
  output?: O;
  annotations?: McpAnnotations;
  /**
   * A plain object becomes structuredContent plus its JSON as text; an McpContent goes as is; a thrown ApiError
   * becomes isError with its PB code (`permissao_negada` for 403). Long work should watch ctx.signal: a timed-out
   * call is answered at once, but the handler is not killed.
   */
  handler(args: z.infer<I>, ctx: McpCtx): Promise<O extends AnyObject ? z.infer<O> : unknown>;
}

/** One content of a resource: text, or base64 blob. */
export type McpResourceContents =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

/** What read() returns: text (JSON-encoded when not a string) or full contents. */
export type McpReadResult = string | Record<string, unknown> | unknown[] | { contents: McpResourceContents[] };

export interface McpResourceDef extends Guarded {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Cache hint for 2026-07-28 clients; 0 or unset means no caching. */
  ttlMs?: number;
  read(ctx: McpCtx): Promise<McpReadResult>;
}

export interface McpResourceTemplateDef extends Guarded {
  /** RFC 6570, e.g. `record://{collection}/{id}`; the name doubles as the registry key. */
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  ttlMs?: number;
  /** Concrete resources for resources/list. */
  list?(ctx: McpCtx): Promise<{ uri: string; name: string; mimeType?: string; description?: string }[]>;
  /** Completion per variable. */
  complete?: Record<string, (value: string, ctx: McpCtx) => string[] | Promise<string[]>>;
  read(uri: URL, vars: Record<string, string>, ctx: McpCtx): Promise<McpReadResult>;
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpPromptDef<A extends McpPromptArgs = McpPromptArgs> extends Guarded {
  name: string;
  title?: string;
  description: string;
  args?: A;
  /** A string is one user message. */
  render(args: z.infer<A>, ctx: McpCtx): McpPromptMessage[] | string | Promise<McpPromptMessage[] | string>;
}

/** A plugged tracer (telemetry lives elsewhere; the MCP never imports it). */
export interface McpTracer {
  span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  /** When present, the superuser-only `<prefix>traces` tool is registered over it. */
  query?(args: { limit: number; filter?: string }): Promise<unknown>;
}

export interface McpOptions {
  /** Defaults to true: POST /api/mcp is served. */
  enabled?: boolean;
  /** Prefix of the built-in tools; default "db_". */
  prefix?: string;
  /** Browser origins allowed besides localhost, the request's own origin and settings.meta.appURL. */
  allowedOrigins?: string[];
  /**
   * Refuse tokens without `aud` = <appURL>/api/mcp (tokens from app.mcp.token carry it), so a session token of the
   * SPA is not accepted as an MCP credential. Default true; false is a dev convenience.
   */
  requireAudience?: boolean;
  /** Serve guests (no token) with guest access rules instead of 401. Default false. */
  allowGuest?: boolean;
  /** Tool text above this is truncated with `truncated: true`. Default 256 KiB. */
  maxResultBytes?: number;
  /** Per-call wall time. Default 30 s. */
  toolTimeoutMs?: number;
  /** true (default) registers every built-in, false none, a list only those names (without prefix). */
  builtins?: boolean | string[];
  /**
   * The embedded OAuth authorization server (/oauth/*, RFC 8414 metadata): users authorize an MCP client on the
   * server's own pages. On by default (authorizing `_superusers`); settings.oauth tunes it at runtime.
   */
  oauth?: OAuthOptions;
}

export type ResolvedMcpOptions = Required<Omit<McpOptions, "oauth">> & { oauth: ResolvedOAuthOptions };

export interface McpListing {
  tools: string[];
  resources: string[];
  resourceTemplates: string[];
  prompts: string[];
}

/** The extension API a consumer gets as app.mcp. Every register returns its unregister. */
/** The registration surface shared by app.mcp and a group. */
export interface McpRegistrar {
  tool<I extends AnyObject, O extends AnyObject | undefined = undefined>(def: McpToolDef<I, O>): () => void;
  resource(def: McpResourceDef): () => void;
  resourceTemplate(def: McpResourceTemplateDef): () => void;
  prompt<A extends McpPromptArgs>(def: McpPromptDef<A>): () => void;
}

/**
 * A consumer's namespace: every name registered through it gets the prefix (so it is written once), and off()
 * removes all of them. The prefix must differ from the built-ins' one.
 */
export interface McpGroup extends McpRegistrar {
  readonly prefix: string;
  off(): void;
}

export interface Mcp extends McpRegistrar {
  readonly options: ResolvedMcpOptions;
  /** A prefixed namespace (e.g. "pbs_") whose registrations come off together. */
  group(prefix: string): McpGroup;
  /** Names registered, sorted (introspection and tests). */
  list(): McpListing;
  /** Plugs tracing into ctx.span; registers `<prefix>traces` when the tracer can query. */
  useTracer(tracer: McpTracer): void;
  /**
   * A static, non-refreshable auth token for an MCP client config, with `aud` = this server's MCP URL
   * (settings.meta.appURL, or baseURL when appURL is empty). The REST API refuses it: it only opens /api/mcp.
   */
  token(collection: string, id: string, opts?: { ttl?: number; baseURL?: string }): Promise<string>;
}
