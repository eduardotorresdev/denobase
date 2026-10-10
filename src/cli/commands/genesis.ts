import type { DatabaseSync } from "node:sqlite";
import { tx } from "../../core/db.ts";
import * as migrations from "../../migrations/mod.ts";
import { create, makeReq } from "../../engine/mod.ts";
import { quoteIdent } from "../../schema/mod.ts";
import { type Command } from "../engine.ts";
import { createStore } from "../../store/mod.ts";
import { openFileDb } from "../data.ts";

/** PocketBase core.DefaultInstallerEmail. */
export const INSTALLER_EMAIL = "__pbinstaller@example.com";

export const genesisCommand: Command = {
  name: "genesis",
  usage: "[--email --password] [--db path]",
  description: "start a new database with the first superuser",
  run: (c) => genesis({ dbPath: c.str("db"), email: c.str("email"), password: c.str("password") }),
};

/** Refusals checked before any write, in order: missing credentials, multiple heads, pending migrations. */
export async function genesisPreflight(
  db: DatabaseSync,
  email?: string,
  password?: string,
  dir: URL = migrations.MIGRATIONS_DIR,
): Promise<void> {
  if (!email || !password) throw new Error("set --email and --password (or ADMIN_EMAIL and ADMIN_PASSWORD)");
  const ms = await migrations.loadMigrations(dir);
  if (migrations.heads(ms).length > 1) throw new Error("multiple heads: run `reconcile` first");
  migrations.ensureMigrationsTable(db);
  const { pending } = migrations.status(db, ms);
  if (pending.length > 0) throw new Error(`pending migrations (${pending.join(", ")}); run \`migrate up\` first`);
}

/** Starts a new database once with the first superuser; migrations stay schema only (api/cmd/genesis). */
export async function genesis(opts: { dbPath?: string; email?: string; password?: string }): Promise<void> {
  const email = opts.email ?? Deno.env.get("ADMIN_EMAIL");
  const password = opts.password ?? Deno.env.get("ADMIN_PASSWORD");
  if (!email || !password) throw new Error("set --email and --password (or ADMIN_EMAIL and ADMIN_PASSWORD)");
  const db = openFileDb(opts.dbPath);
  try {
    await genesisPreflight(db, email, password);
    await runGenesis(db, email, password);
    console.log(`Database started; superuser ${email} created.`);
  } finally {
    db.close();
  }
}

/** The write half of genesis, in one tx so a failed superuser leaves the db unstarted. */
export async function runGenesis(db: DatabaseSync, email: string, password: string): Promise<void> {
  await tx(db, async () => {
    // The installer placeholder is not a real admin, so it must not block genesis (api/cmd genesis parity).
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent("_superusers")} WHERE email != ?`)
      .get(INSTALLER_EMAIL) as { n: number };
    if (row.n > 0) throw new Error("database already started: genesis only runs on a database without superusers");
    const req = makeReq(createStore(db), { id: "genesis", collection: "_superusers", record: { id: "genesis" } });
    await create({
      collection: "_superusers",
      req,
      overrideAccess: true,
      data: { email, password, passwordConfirm: password },
    });
  });
}
