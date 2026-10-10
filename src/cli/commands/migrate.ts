import { collections } from "../../core/registry.ts";
import * as migrations from "../../migrations/mod.ts";
import { type Command, UsageError } from "../engine.ts";
import { openFileDb } from "../data.ts";

export const migrateCommand: Command = {
  name: "migrate",
  usage: "up|status|create [--db path]",
  description: "apply, inspect or generate migrations",
  run: (c) => migrate(c.args[0], c.str("db")),
};

export const reconcileCommand: Command = {
  name: "reconcile",
  description: "write a merge migration for multiple heads",
  run: async () => {
    const m = await migrations.reconcile(collections);
    console.log(m ? `merge migration ${m.id} written` : "nothing to reconcile");
  },
};

async function migrate(sub: string | undefined, dbPath?: string): Promise<void> {
  if (sub === "create") {
    const m = await migrations.create(collections);
    console.log(m ? `migration ${m.id} written` : "no changes");
    return;
  }
  if (sub !== "up" && sub !== "status") throw new UsageError();
  const db = openFileDb(dbPath);
  try {
    const ms = await migrations.loadMigrations();
    if (sub === "up") {
      const applied = await migrations.up(db, ms);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
    } else {
      migrations.ensureMigrationsTable(db);
      const s = migrations.status(db, ms);
      console.log(
        `applied: ${s.applied.length}\npending: ${s.pending.join(", ") || "-"}\nheads: ${s.heads.join(", ")}`,
      );
    }
  } finally {
    db.close();
  }
}
