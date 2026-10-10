import type { OAuthScope } from "./types.ts";

export const DEFAULT_SCOPE = "mcp";
export const OFFLINE_ACCESS = "offline_access";

/** The built-in scopes. Scopes only ever narrow what the user's collection access already allows. */
export const BUILTIN_SCOPES: OAuthScope[] = [
  { name: "mcp", description: "Use the MCP tools with your access rules.", tools: () => true },
  {
    name: "mcp:read",
    description: "Only read-only MCP tools (no writes).",
    tools: (t) => t.readOnly,
  },
  { name: "mcp:write", description: "Every MCP tool, limited to what you can do.", tools: () => true },
  { name: OFFLINE_ACCESS, description: "Stay connected (refresh token) while you are away." },
];

/** The scopes this server knows: built-ins first, then the app's (an app scope cannot shadow a built-in). */
export function scopeRegistry(extra: OAuthScope[] = []): Map<string, OAuthScope> {
  const map = new Map<string, OAuthScope>();
  for (const s of [...BUILTIN_SCOPES, ...extra]) {
    if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s.name)) throw new Error(`oauth: invalid scope name ${s.name}`);
    if (map.has(s.name)) throw new Error(`oauth: duplicate scope ${s.name}`);
    map.set(s.name, s);
  }
  return map;
}

export const splitScope = (s: string | null | undefined): string[] => [
  ...new Set((s ?? "").split(" ").filter(Boolean)),
];

/**
 * The scopes a request may get: what it asked (or the default), each one known, inside what the client registered
 * (when it registered any). Unknown → null (invalid_scope).
 */
export function resolveRequestedScopes(
  requested: string | null | undefined,
  known: Map<string, OAuthScope>,
  clientScope: string,
): string[] | null {
  const asked = splitScope(requested);
  const want = asked.length ? asked : [DEFAULT_SCOPE];
  if (want.some((s) => !known.has(s))) return null;
  const allowed = splitScope(clientScope);
  if (allowed.length && want.some((s) => !allowed.includes(s))) return null;
  return want;
}

/** Whether these scopes open a tool. undefined scopes (a manual app.mcp.token) open every tool. */
export function toolAllowed(
  tool: { name: string; readOnly: boolean },
  scopes: string[] | undefined,
  known: Map<string, OAuthScope>,
): boolean {
  if (!scopes) return true;
  return scopes.some((name) => {
    const t = known.get(name)?.tools;
    if (!t) return false;
    return Array.isArray(t) ? t.includes(tool.name) : t(tool);
  });
}

/** Resources and prompts only read: any scope that opens some tool opens them. */
export function readsAllowed(scopes: string[] | undefined, known: Map<string, OAuthScope>): boolean {
  if (!scopes) return true;
  return scopes.some((name) => !!known.get(name)?.tools);
}
