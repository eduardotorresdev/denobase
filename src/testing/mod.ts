import { DatabaseSync } from "node:sqlite";
import { type App, createApp } from "../app.ts";
import { MemoryMailer } from "../auth/mailer.ts";
import { signAuthToken } from "../auth/jwt.ts";
import type { AuthUser, Doc, Req } from "../core/types.ts";
import { makeReq } from "../engine/mod.ts";
import { quoteIdent } from "../schema/mod.ts";
import { ensureMathFunctions, openDb, tuneConnection } from "../core/db.ts";
import type { CollectionConfig } from "../core/types.ts";
import * as migrations from "../migrations/mod.ts";
import type { Store } from "../store/mod.ts";
import type { StoredSpan } from "../telemetry/store.ts";

/** Consumer's template db (every migration applied, no data); set through setTemplateDb. */
export let TEMPLATE_DB: URL = new URL("./test_data/data.db", `file://${Deno.cwd()}/`);

export function setTemplateDb(path: URL): void {
  TEMPLATE_DB = path;
  template = undefined;
}

let template: Uint8Array | undefined;

/** Template bytes read once per process; a missing file points at the command that builds it. */
function templateBytes(): Uint8Array {
  if (!template) {
    try {
      template = asRollbackJournal(Deno.readFileSync(TEMPLATE_DB));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error("test_data/data.db missing: run `deno run -A main.ts test-data`");
      }
      throw e;
    }
  }
  return template;
}

/** Header bytes 18/19 = 2 mark WAL, which an in-memory deserialized db cannot open; 1 = rollback journal. */
export function asRollbackJournal(bytes: Uint8Array): Uint8Array {
  if (bytes[18] === 2 || bytes[19] === 2) {
    bytes = bytes.slice();
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return bytes;
}

/**
 * In-memory db holding a copy of bytes. Measured on Deno 2.9 / node:sqlite with a 5-table template:
 * deserialize 0.13 ms/op, node:sqlite backup() 1.6 ms/op, Deno.copyFile + open 5.6 ms/op; deserialize wins.
 */
export function restore(bytes: Uint8Array): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.deserialize(bytes);
  tuneConnection(db, { file: false });
  ensureMathFunctions(db);
  return db;
}

/** Fresh DB from the template loaded once per process. */
export function freshDb(): DatabaseSync {
  return restore(templateBytes());
}

export interface TestApp {
  db: DatabaseSync;
  app: App;
  /** app.store: what factories and direct reads take. */
  store: Store;
  mailer: MemoryMailer;
  /** fetch against the app with optional bearer token. */
  request(method: string, path: string, opts?: { token?: string; body?: unknown }): Promise<Response>;
}

export function testApp(): TestApp {
  const db = freshDb();
  const mailer = new MemoryMailer();
  const app = createApp({ db, mailer });
  return {
    db,
    app,
    store: app.store,
    mailer,
    request: async (method, path, opts = {}) => {
      const headers: Record<string, string> = {};
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      return await app.http.request(path, { method, headers, body });
    },
  };
}

/** Signed token for a record; tokenKey is read from the db because records never expose it. */
export async function tokenFor(db: DatabaseSync, collection: string, record: Doc): Promise<string> {
  const row = db.prepare(`SELECT ${quoteIdent("tokenKey")} AS k FROM ${quoteIdent(collection)} WHERE id = ?`)
    .get(record.id) as { k: string } | undefined;
  if (!row) throw new Error(`tokenFor: ${collection}/${record.id} not found`);
  return await signAuthToken(collection, { id: record.id, tokenKey: row.k });
}

export function reqAs(store: Store, user: AuthUser | null): Req {
  return makeReq(store, user);
}

/** In-memory db with the tables (and views) of cs, built by the same migration ops `migrate up` runs. */
export async function dbWith(cs: CollectionConfig[], db: DatabaseSync = openDb(":memory:")): Promise<DatabaseSync> {
  const ops = migrations.diff({}, migrations.configToSnapshot(cs));
  await migrations.up(db, [{ id: "schema", parents: [], ops }]);
  return db;
}

/**
 * The spans an app recorded, read back after a synchronous flush (the tracer otherwise writes after the current
 * tick), in start order; reset() forgets them. Tracing must be enabled in the app's settings (it is by default).
 */
export function collectSpans(app: App): { spans(): StoredSpan[]; reset(): void } {
  return {
    spans: () => {
      app.tracer.flush();
      return (app.traces.db.prepare(`SELECT "traceId" FROM _spans GROUP BY "traceId" ORDER BY MIN(start)`).all() as {
        traceId: string;
      }[]).flatMap((r) => app.traces.spans(r.traceId));
    },
    reset: () => {
      app.tracer.flush();
      app.traces.truncate();
    },
  };
}
