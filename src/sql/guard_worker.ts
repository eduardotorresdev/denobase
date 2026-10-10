/// <reference lib="deno.worker" />
import { ensureMathFunctions, tuneConnection } from "../core/db.ts";
// One guarded query per worker: guard.ts terminates it on timeout, so nothing here may outlive the reply.
import { DatabaseSync } from "node:sqlite";
import {
  returnArrays,
  setAuthorizer,
  setLimits,
  SQLITE_DENY,
  SQLITE_FUNCTION,
  SQLITE_OK,
  SQLITE_READ,
  SQLITE_RECURSIVE,
  SQLITE_SELECT,
} from "./sqlite_ext.ts";
import type { GuardLayer, GuardRequest, GuardResponse } from "./guard.ts";

/** Per-connection SQLite limits (a query is small; its expressions shallow. */
const LIMITS = { length: 1_000_000, sqlLength: 20_000, exprDepth: 100, compoundSelect: 10, column: 200 };

class Refusal extends Error {
  constructor(readonly layer: GuardLayer, message: string) {
    super(message);
  }
}

/** Auth secrets (`_superusers`, `_otps`), SQLite's catalog and pragma table functions (schema introspection). */
function isSystem(table: string): boolean {
  return table.startsWith("_") || table.startsWith("sqlite_") || table.startsWith("pragma_");
}

function run(r: GuardRequest): GuardResponse {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(r.path, { readOnly: true });
    tuneConnection(db, { file: true, readOnly: true });
    ensureMathFunctions(db);
  } catch (e) {
    return { ok: false, layer: null, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; PRAGMA trusted_schema = OFF;");
    setLimits(db, LIMITS);
    const allowed = r.tables ? new Set(r.tables) : null;
    const denied = new Set(r.deniedColumns);
    const read = new Set<string>();
    let refusal: Refusal | null = null;
    const deny = (layer: GuardLayer, message: string) => {
      refusal ??= new Refusal(layer, message);
      return SQLITE_DENY;
    };
    setAuthorizer(db, (op, a1, a2) => {
      switch (op) {
        case SQLITE_SELECT:
        case SQLITE_FUNCTION:
        case SQLITE_RECURSIVE:
          return SQLITE_OK;
        case SQLITE_READ: {
          const table = a1 ?? "";
          // json_each/json_tree are table-valued functions, read like a table.
          if (table === "json_each" || table === "json_tree") return SQLITE_OK;
          if (isSystem(table) || (allowed && !allowed.has(table))) {
            return deny("tabelas", `tabela ${table} nao liberada`);
          }
          if (denied.has(`${table}.${a2 ?? ""}`)) return deny("tabelas", `coluna ${table}.${a2} nao liberada`);
          read.add(table);
          return SQLITE_OK;
        }
        default:
          return deny("conexao", "so leitura e permitida");
      }
    });
    const sql = r.sql.trim().replace(/;+\s*$/, "");
    let stmt;
    try {
      // The wrapper only prepares around one SELECT/WITH: a second statement or a dangling clause fails here.
      stmt = db.prepare(`SELECT * FROM (\n${sql}\n) LIMIT ${r.maxRows + 1}`);
    } catch (e) {
      if (refusal) throw refusal;
      throw new Refusal("forma", e instanceof Error ? e.message : String(e));
    }
    returnArrays(stmt);
    const columns = stmt.columns().map((c) => c.name);
    const rows: unknown[][] = [];
    let bytes = 2;
    let truncated = false;
    for (const row of stmt.iterate(...r.params) as Iterable<unknown[]>) {
      if (rows.length === r.maxRows) {
        truncated = true;
        break;
      }
      const size = JSON.stringify(row, (_k, v) => typeof v === "bigint" ? v.toString() : v).length + 1;
      if (bytes + size > r.maxBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      rows.push(row);
    }
    return { ok: true, result: { columns, rows, truncated, tables: [...read].sort() } };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, layer: e.layer, message: e.message };
    const msg = e instanceof Error ? e.message : String(e);
    // Writes that slipped past compile (they cannot, but the connection is the last layer) land here.
    return { ok: false, layer: /readonly|query_only/i.test(msg) ? "conexao" : null, message: msg };
  } finally {
    db.close();
  }
}

self.onmessage = (e: MessageEvent<GuardRequest>) => {
  self.postMessage(run(e.data));
};
