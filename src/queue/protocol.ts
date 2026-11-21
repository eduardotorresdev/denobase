import type { JobErrorCode, JobRow, QueueName } from "./types.ts";

/**
 * Supervisor <-> executor, NDJSON over the executor's stdin/stdout. Protocol lines carry MARK; anything else an
 * executor prints on stdout (a handler's console.log that slipped through) is relayed as a log line, never parsed.
 */
export const MARK = "\u001edbq ";

export type ToExecutor =
  | { t: "run"; job: JobRow }
  | { t: "abort"; id: string; reason: "timeout" | "canceled" | "lost" | "shutdown" };

export interface CatalogEntry {
  name: string;
  queue: QueueName;
}

export type FromExecutor =
  | { t: "ready"; catalog: CatalogEntry[] }
  | {
    t: "done";
    id: string;
    leaseId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    code?: JobErrorCode;
    traceId?: string;
    lost?: boolean;
    /** It shared its process with a rejection nobody handled: maybe its own, maybe a neighbour's. Given back
     * quarantined without a try; alone, the culprit then fails by itself (B2). */
    suspect?: string;
  }
  | { t: "fatal"; error: string };

export function encode(m: ToExecutor | FromExecutor): string {
  return MARK + JSON.stringify(m) + "\n";
}

/** Splits a byte stream into lines. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

/** Where an executor is: the kind and what it needs to build its app. */
export interface ExecutorArgs {
  kind: "normal" | "heavy" | "list";
  db: string;
  aux: string;
  storage?: string;
  dataDir?: string;
  setup?: string;
}

export function executorArgv(a: ExecutorArgs): string[] {
  const out = ["--kind", a.kind, "--db", a.db, "--aux", a.aux];
  if (a.storage) out.push("--storage", a.storage);
  if (a.dataDir) out.push("--data-dir", a.dataDir);
  if (a.setup) out.push("--setup", a.setup);
  return out;
}
