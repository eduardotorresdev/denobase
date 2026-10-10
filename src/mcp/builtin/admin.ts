import { z } from "zod";
import { badRequest, notFound } from "../../core/errors.ts";
import type { DatabaseSync } from "node:sqlite";
import { guardedQuery, SqlRejected } from "../../sql/guard.ts";
import { setAuthorizer, SQLITE_OK, SQLITE_READ } from "../../sql/sqlite_ext.ts";
import { ReadOnlySqlError, selectRows } from "../../sql/read.ts";
import { dbPath } from "../../workers/mod.ts";
import { backupName, type Backups, validKey } from "../../backups/mod.ts";
import { mergeSettings, publicSettings, saveSettings, type Settings, validateSettings } from "../../settings/mod.ts";
import { LEVEL } from "../../logs/mod.ts";
import type { McpHost } from "../host.ts";

export const SQL_MAX_ROWS = 500;

/** Auth secrets (`_superusers`, `_otps`), SQLite's catalog and pragma functions, as sql/guard_worker refuses them. */
function refuseSystemTables(db: DatabaseSync, sql: string): void {
  let table = "";
  setAuthorizer(db, (op, a1) => {
    const t = a1 ?? "";
    if (op === SQLITE_READ && !table && (t.startsWith("_") || t.startsWith("sqlite_") || t.startsWith("pragma_"))) {
      table = t;
    }
    return SQLITE_OK;
  });
  try {
    db.prepare(sql);
  } catch {
    // selectRows reports the statement's own error.
  } finally {
    setAuthorizer(db, null);
  }
  if (table) throw new SqlRejected("tabelas", `tabela ${table} nao liberada`);
}
export const SQL_TIMEOUT_MS = 5000;

/** Superuser-only operations: SQL, logs, crons, backups and settings, as the admin API does them. */
export function adminTools(host: McpHost, p: string): void {
  const app = () => host.app;
  const su = "superuser" as const;

  host.tool({
    name: `${p}sql`,
    title: "Read-only SQL",
    description: `One read-only SELECT/WITH on the main db (no access rules: superuser only). At most ` +
      `${SQL_MAX_ROWS} rows, ${SQL_TIMEOUT_MS} ms; system tables (_*) are refused.`,
    visibility: su,
    annotations: { readOnly: true, idempotent: true },
    input: z.object({
      sql: z.string().min(1),
      params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
      maxRows: z.number().int().min(1).max(SQL_MAX_ROWS).optional(),
    }),
    handler: async (a) => {
      const maxRows = a.maxRows ?? 100;
      const path = dbPath(app().db);
      try {
        if (path) {
          const r = await guardedQuery(path, a.sql, a.params ?? [], {
            maxRows,
            maxBytes: host.options.maxResultBytes,
            timeoutMs: SQL_TIMEOUT_MS,
          });
          return { columns: r.columns, rows: r.rows, truncated: r.truncated, tables: r.tables };
        }
        // An in-memory db (tests, ephemeral apps) has no file for the guard's worker: the read-only authorizer, plus
        // the same system-table refusal the worker applies, checked on the tables SQLite reports for the statement.
        refuseSystemTables(app().db, a.sql);
        const rows = selectRows(app().db, a.sql, a.params ?? []);
        const columns = rows.length ? Object.keys(rows[0]) : [];
        return {
          columns,
          rows: rows.slice(0, maxRows).map((r) => columns.map((c) => r[c])),
          truncated: rows.length > maxRows,
          tables: [],
        };
      } catch (e) {
        if (e instanceof SqlRejected) throw badRequest(`SQL rejected (${e.layer}): ${e.reason}`);
        if (e instanceof ReadOnlySqlError) throw badRequest(e.message);
        if (e instanceof Error && /SQLITE|syntax|no such/i.test(e.message)) throw badRequest(e.message);
        throw e;
      }
    },
  });

  host.tool({
    name: `${p}logs`,
    title: "Logs",
    description: 'The app logs (_logs): op=list (PB filter/sort, e.g. filter "level >= 8" for errors), ' +
      "op=get (id), op=stats (requests per hour).",
    visibility: su,
    annotations: { readOnly: true, idempotent: true },
    input: z.object({
      op: z.enum(["list", "get", "stats"]),
      id: z.string().optional(),
      filter: z.string().optional(),
      sort: z.string().optional().describe("Default '-created'."),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(200).optional(),
    }),
    handler: (a) => {
      const logs = app().logs;
      if (a.op === "get") {
        const log = a.id ? logs.get(a.id) : null;
        if (!log) throw notFound();
        return Promise.resolve(log);
      }
      if (a.op === "stats") return Promise.resolve({ items: logs.stats(a.filter || undefined) });
      return Promise.resolve(
        logs.list({ filter: a.filter || undefined, sort: a.sort || "-created", page: a.page, perPage: a.perPage }),
      );
    },
  });

  host.tool({
    name: `${p}crons_list`,
    title: "Cron jobs",
    description: "The registered cron jobs (id, expression).",
    visibility: su,
    annotations: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler: () => Promise.resolve({ items: app().cron.jobs().map((j) => ({ id: j.id, expression: j.expression })) }),
  });

  host.tool({
    name: `${p}crons_run`,
    title: "Run cron job",
    description: "Starts one cron job now, in the background (like POST /api/crons/{id}).",
    visibility: su,
    annotations: { destructive: false, openWorld: true },
    input: z.object({ id: z.string().min(1) }),
    handler: (a) => {
      const job = app().cron.get(a.id);
      if (!job) throw notFound("Missing or invalid cron job");
      void job.run("manual");
      return Promise.resolve({ started: a.id });
    },
  });

  // Without a pb_data dir there are no backups: the tools are absent rather than always failing.
  const backups = (): Backups => app().backups!;
  const hasBackups = () => !!app().backups;
  host.tool({
    name: `${p}backups_list`,
    title: "Backups",
    description: "The backup zips in pb_data/backups.",
    visibility: su,
    allow: hasBackups,
    annotations: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler: async () => ({ items: await backups().list() }),
  });
  host.tool({
    name: `${p}backups_create`,
    title: "Create backup",
    description: "Zips data.db, auxiliary.db and storage/ into pb_data/backups (name defaults to PB's).",
    visibility: su,
    allow: hasBackups,
    annotations: { destructive: false },
    input: z.object({ name: z.string().regex(/^[a-z0-9_-]{1,145}\.zip$/).optional() }),
    handler: async (a) => {
      const b = backups();
      if (b.active) throw badRequest("Try again later - another backup/restore process has already been started");
      const name = a.name ?? backupName(app().settings.meta.appName, "pb_backup_");
      if (await b.exists(name)) throw badRequest("The backup file name is invalid or already exists.");
      await b.create(name);
      return { created: name };
    },
  });
  host.tool({
    name: `${p}backups_restore`,
    title: "Restore backup",
    description: "Replaces pb_data with the backup and restarts the server. Everything after the backup is lost.",
    visibility: su,
    allow: hasBackups,
    annotations: { destructive: true },
    input: z.object({ key: z.string().min(1) }),
    handler: async (a) => {
      const b = backups();
      if (b.active) throw badRequest("Try again later - another backup/restore process has already been started.");
      if (!validKey(a.key) || !(await b.exists(a.key))) throw badRequest("Missing or invalid backup file.");
      // Like the REST route: answer first, restore a second later (the restore restarts the process).
      setTimeout(() => b.restore(a.key).catch((e) => console.error("Failed to restore backup", a.key, e)), 1000);
      return { restoring: a.key };
    },
  });
  host.tool({
    name: `${p}backups_delete`,
    title: "Delete backup",
    description: "Deletes one backup zip.",
    visibility: su,
    allow: hasBackups,
    annotations: { destructive: true, idempotent: true },
    input: z.object({ key: z.string().min(1) }),
    handler: async (a) => {
      const b = backups();
      if (b.active === a.key) throw badRequest("The backup is currently being used and cannot be deleted.");
      if (!validKey(a.key) || !(await b.exists(a.key))) throw badRequest("Invalid or already deleted backup file.");
      await b.delete(a.key);
      return { deleted: a.key };
    },
  });

  host.tool({
    name: `${p}settings_get`,
    title: "Settings",
    description: "The app settings; secrets (smtp password, s3 secrets) are never included.",
    visibility: su,
    annotations: { readOnly: true, idempotent: true },
    input: z.object({}),
    handler: () => Promise.resolve(publicSettings(app().settings)),
  });
  host.tool({
    name: `${p}settings_patch`,
    title: "Patch settings",
    description: "Deep-merges a patch into the settings, validates and saves it (PATCH /api/settings).",
    visibility: su,
    annotations: { destructive: true, idempotent: true },
    input: z.object({ patch: z.record(z.string(), z.unknown()) }),
    handler: (a) => {
      const ctx = host.http;
      const next = mergeSettings<Settings>(structuredClone(ctx.settings), a.patch);
      const errs = validateSettings(next);
      if (Object.keys(errs).length) throw badRequest("An error occurred while saving the new settings.", errs);
      saveSettings(ctx.db, next);
      Object.assign(ctx.settings, next);
      for (const fn of ctx.onSettingsChange) fn(ctx.settings);
      return Promise.resolve(publicSettings(ctx.settings));
    },
  });

  host.resource({
    uri: "settings://public",
    name: "settings",
    title: "Settings",
    description: "The app settings without secrets.",
    mimeType: "application/json",
    visibility: su,
    read: () => Promise.resolve(publicSettings(app().settings)),
  });
  host.resourceTemplate({
    name: "logs_recent",
    uriTemplate: "logs://recent{?level}",
    title: "Recent logs",
    description: "The last 100 log lines; level=error|warn|info|debug keeps that level and above.",
    mimeType: "application/json",
    visibility: su,
    complete: { level: (v) => Object.keys(LEVEL).filter((l) => l.startsWith(v)) },
    read: (_uri, vars) => {
      const min = LEVEL[vars.level as keyof typeof LEVEL];
      return Promise.resolve(
        app().logs.list({ filter: min === undefined ? undefined : `level >= ${min}`, sort: "-created", perPage: 100 }),
      );
    },
  });
}
