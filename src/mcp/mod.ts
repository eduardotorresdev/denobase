/**
 * The native MCP server: POST /api/mcp (Streamable HTTP) and the `mcp` CLI command (stdio), over one registry the
 * consumer extends through app.mcp (tools, resources, resource templates, prompts). Every handler runs as the
 * authenticated principal with app.store.as(user), so collection access rules apply as on the REST API.
 *
 * Extension contract: one name rule for every kind (NAME in registry.ts); resource and template names share one
 * space. `allow(ctx)` may be async and decides tools/list. A tool's `output` (object schema) types the handler's
 * return and is validated. Prompt args are strings, as on the wire. `app.mcp.group("pbs_")` prefixes names and
 * comes off with one `off()`. A tool's ApiError is an isError `{code, status, message, data}`; a resource's or
 * prompt's is a JSON-RPC error with the same body in `data`. `list_changed` is declared where it can be delivered:
 * stdio (the connection follows the registry) and 2026-07-28 HTTP (subscriptions/listen), not 2025 stateless HTTP.
 * Tokens: `requireAudience` (default) wants `aud` = <appURL>/api/mcp (app.mcp.token); such a token is a guest on REST.
 */
export type {
  Mcp,
  McpAnnotations,
  McpContent,
  McpCtx,
  McpGroup,
  McpListing,
  McpOptions,
  McpPromptArgs,
  McpPromptDef,
  McpPromptMessage,
  McpReadResult,
  McpRegistrar,
  McpResourceContents,
  McpResourceDef,
  McpResourceTemplateDef,
  McpToolDef,
  McpTracer,
  McpVisibility,
} from "./types.ts";
export { MCP_PATH, mcpResource } from "./host.ts";
export { principalByEmail, serveMcpStdio, STDIO_SUPERUSER } from "./stdio.ts";
export { BUILTIN_GROUPS, type BuiltinGroup } from "./builtin/mod.ts";
