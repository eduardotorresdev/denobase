import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { App } from "../app.ts";
import type { AuthUser, Doc } from "../core/types.ts";
import { publicAuthRecord } from "../auth/jwt.ts";
import type { McpHost } from "./host.ts";
import { buildServer, mcpContext } from "./server.ts";

/** The implicit principal of a stdio session without --as: whoever runs the process already owns the db file. */
export const STDIO_SUPERUSER: AuthUser = { id: "", collection: "_superusers", record: { id: "" } };

/** Auth record by email across the app's auth collections (superusers first), as the principal of a session. */
export async function principalByEmail(app: App, email: string): Promise<AuthUser | null> {
  const host = app.mcp as McpHost;
  const auth = host.http.collections.filter((c) => c.auth)
    .sort((a, b) => Number(b.slug === "_superusers") - Number(a.slug === "_superusers"));
  for (const c of auth) {
    const doc = await app.store.collection(c.slug).query().where({ email: { equals: email } }).first() as
      | Doc
      | undefined;
    if (doc) return { id: doc.id, collection: c.slug, record: publicAuthRecord(doc) };
  }
  return null;
}

/**
 * Serves the app's MCP over stdio (or the given transport) as `user`; one McpServer per connection from the same
 * registry and factory as HTTP. The connection follows the registry: a later app.mcp.tool(...) reaches the client
 * as list_changed.
 */
export function serveMcpStdio(
  app: App,
  user: AuthUser | null,
  opts: { transport?: ServeStdioOptions["transport"] } = {},
): StdioServerHandle {
  const host = app.mcp as McpHost;
  return serveStdio((rc) => buildServer(host, mcpContext(host, user, "stdio"), { era: rc.era, live: true }), {
    ...(opts.transport ? { transport: opts.transport } : {}),
    onerror: (e) => console.error("mcp stdio", e.message),
  });
}
