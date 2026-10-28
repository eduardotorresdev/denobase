import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type App, type AppOptions, createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { defineCollection } from "../core/define.ts";
import { registerCollections } from "../core/registry.ts";
import { superusers } from "../core/superusers.ts";
import type { Doc } from "../core/types.ts";
import { dbWith, tokenFor } from "../testing/mod.ts";

/** Collections and principals the MCP tests share: an owner-scoped collection, a superuser-only one, a hidden field. */
export const mt_users = defineCollection({
  slug: "mt_users",
  auth: true,
  fields: [{ name: "nome", type: "text" }],
  access: { read: ({ user }) => !!user },
});

export const mt_notas = defineCollection({
  slug: "mt_notas",
  fields: [
    { name: "titulo", type: "text", required: true },
    { name: "segredo", type: "text", hidden: true },
    { name: "dono", type: "relationship", relationTo: "mt_users" },
  ],
  access: {
    read: ({ user }) => (user ? { dono: { equals: user.id } } : false),
    create: ({ user }) => !!user,
    update: ({ user }) => (user ? { dono: { equals: user.id } } : false),
    delete: ({ user }) => (user ? { dono: { equals: user.id } } : false),
  },
});

/** No access fns: superuser only, like a PB nil rule. */
export const mt_cofre = defineCollection({ slug: "mt_cofre", fields: [{ name: "valor", type: "number" }] });

registerCollections(mt_users, mt_notas, mt_cofre);

export const COLLECTIONS = [superusers, mt_users, mt_notas, mt_cofre];

export interface Fixture {
  app: App;
  su: Doc;
  ana: Doc;
  bia: Doc;
  /** MCP tokens (app.mcp.token: aud = this server's MCP URL), what requireAudience (the default) wants. */
  suToken: string;
  anaToken: string;
  biaToken: string;
  /** Ana's plain session token (no aud), as the SPA holds it. */
  anaSession: string;
  /** Ana's and Bia's notes. */
  notaAna: Doc;
  notaBia: Doc;
}

export async function fixture(opts: Partial<AppOptions> = {}): Promise<Fixture> {
  const db = await dbWith(COLLECTIONS);
  const app = createApp({ db, mailer: new MemoryMailer(), collections: COLLECTIONS, adminUiDir: false, ...opts });
  const pw = { password: "12345678", passwordConfirm: "12345678" };
  const su = await app.store.collection(superusers).create({ email: "su@x.io", ...pw } as never) as Doc;
  const ana = await app.store.collection(mt_users).create({ email: "ana@x.io", nome: "Ana", ...pw } as never) as Doc;
  const bia = await app.store.collection(mt_users).create({ email: "bia@x.io", nome: "Bia", ...pw } as never) as Doc;
  const notas = app.store.collection(mt_notas);
  const notaAna = await notas.create({ titulo: "da ana", segredo: "s1", dono: ana.id }) as Doc;
  const notaBia = await notas.create({ titulo: "da bia", segredo: "s2", dono: bia.id }) as Doc;
  await app.store.collection(mt_cofre).create({ valor: 42 });
  return {
    app,
    su,
    ana,
    bia,
    notaAna,
    notaBia,
    suToken: await app.mcp.token("_superusers", su.id),
    anaToken: await app.mcp.token("mt_users", ana.id),
    biaToken: await app.mcp.token("mt_users", bia.id),
    anaSession: await tokenFor(db, "mt_users", ana),
  };
}

/** An SDK client over app.fetch (no socket), as token; mode "modern" negotiates 2026-07-28, else the 2025 handshake. */
export async function connect(app: App, token?: string, mode: "legacy" | "modern" = "legacy"): Promise<Client> {
  const client = new Client(
    { name: "test", version: "1" },
    mode === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: async (url, init) => await app.fetch(new Request(url, init)),
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** A raw JSON-RPC POST to /api/mcp (2025 framing), for status codes and headers the SDK client hides. */
export function rpc(
  app: App,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
  path = "/api/mcp",
): Promise<Response> {
  return Promise.resolve(app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  ));
}

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

/** The structured result of a tool call (or its parsed text). */
export function structured(r: { structuredContent?: unknown; content?: unknown }): Record<string, unknown> {
  if (r.structuredContent) return r.structuredContent as Record<string, unknown>;
  const first = (r.content as { type: string; text?: string }[] | undefined)?.[0];
  return first?.text ? JSON.parse(first.text) : {};
}
