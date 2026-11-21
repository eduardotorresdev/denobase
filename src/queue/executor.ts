/**
 * An executor (§1, §16 N1): a subprocess that builds the consumer's App from the setup and runs the jobs its
 * supervisor hands it, never claiming anything itself. `normal` lives long and runs several jobs at once; `heavy` runs
 * one and exits (a kill is real, its memory its own); `list` prints the catalog of handlers and exits.
 */
import { openDb } from "../core/db.ts";
import { onRecordEvent } from "../engine/events.ts";
import { selectRow } from "../store/sqlite.ts";
import { FsStorage } from "../files/storage.ts";
import { type App, createApp, loadSetup } from "../app.ts";
import { appendEvent } from "./nodes.ts";
import { encode, type ExecutorArgs, type FromExecutor, lines, MARK, type ToExecutor } from "./protocol.ts";
import { runJob } from "./run.ts";
import { markExecutor } from "./context.ts";
import { fileId, sameFileId } from "./restore_marker.ts";

/** Grace between an abort and the executor's own exit on EOF (the supervisor is gone). */
const EOF_GRACE_MS = 5_000;

function send(m: FromExecutor): void {
  const bytes = new TextEncoder().encode(encode(m));
  let off = 0;
  while (off < bytes.length) off += Deno.stdout.writeSync(bytes.subarray(off));
}

/** Handlers print on stderr: stdout is the protocol. */
function divertConsole(): void {
  const err = console.error.bind(console);
  console.log = err;
  console.info = err;
  console.debug = err;
}

/** Records and topics written here reach the serves' realtime through the outbox (§7). */
function forwardEvents(app: App): void {
  onRecordEvent({
    changed: (e) => {
      if (e.db !== app.db || e.remote) return;
      appendEvent(app.logs.db, { kind: "record", slug: e.collection.slug, id: e.id, action: e.action }, Date.now());
    },
    deleting: (e) => {
      if (e.db !== app.db || e.remote) return Promise.resolve();
      const row = selectRow(app.db, e.collection.slug, e.id) ?? undefined;
      return Promise.resolve(() =>
        appendEvent(
          app.logs.db,
          { kind: "record", slug: e.collection.slug, id: e.id, action: "delete", row },
          Date.now(),
        )
      );
    },
  });
  app.realtime.forward((topic, data, access) =>
    appendEvent(app.logs.db, { kind: "topic", topic, data, access }, Date.now())
  );
}

/**
 * Every executor watches its parent from a thread of its own: a job stuck in synchronous code never reads stdin's
 * EOF, the thread still runs and kills the process (§17, R7). An orphan is reparented (ppid changes) on every Unix;
 * on Linux /proc also tells a parent that died. Windows has no ppid change to watch: there EOF is the signal.
 */
function watchParent(): void {
  if (Deno.build.os === "windows") return;
  const src = `
    const pp = Deno.ppid;
    const linux = Deno.build.os === "linux";
    setInterval(() => {
      let alive = true;
      if (linux) {
        try { Deno.statSync("/proc/" + pp); } catch (e) { alive = !(e instanceof Deno.errors.NotFound); }
      }
      if (!alive || Deno.ppid !== pp) Deno.kill(Deno.pid, "SIGKILL");
    }, 1000);
  `;
  new Worker(`data:application/javascript,${encodeURIComponent(src)}`, { type: "module" });
}

export async function runExecutor(a: ExecutorArgs, setup?: URL | string): Promise<number> {
  divertConsole();
  markExecutor();
  const app = createApp({
    db: openDb(a.db),
    auxDb: openDb(a.aux),
    storage: a.storage ? new FsStorage(a.storage) : undefined,
    dataDir: a.dataDir,
    adminUiDir: false,
    role: "executor",
    setup: setup ?? a.setup,
  });
  try {
    await loadSetup(app);
  } catch (e) {
    send({ t: "fatal", error: `setup failed: ${(e as Error).message}` });
    return 1;
  }
  const catalog = app.queue.definitions().map((d) => ({ name: d.name, queue: d.opts.queue }));
  send({ t: "ready", catalog });
  if (a.kind === "list") return 0;
  forwardEvents(app);
  watchParent();
  const opened = fileId(a.db);
  const sameFile = () => sameFileId(a.db, opened);
  type Entry = { ac: AbortController; done: Promise<void>; failed?: string; suspect?: string };
  const running = new Map<string, Entry>();

  const run = (m: Extract<ToExecutor, { t: "run" }>) => {
    const ac = new AbortController();
    const entry: Entry = { ac, done: Promise.resolve() };
    entry.done = (async () => {
      const r = await runJob({ app, db: app.db, signal: ac.signal, thread: "executor", sameFile }, m.job);
      // A rejection nobody caught while it ran fails it, even when its handler returned (R6).
      if (entry.suspect) send({ t: "done", id: m.job.id, leaseId: m.job.leaseId!, ...r, suspect: entry.suspect });
      else if (r.ok && entry.failed) {
        send({
          t: "done",
          id: m.job.id,
          leaseId: m.job.leaseId!,
          ...r,
          ok: false,
          error: entry.failed,
          code: "handler",
        });
      } else send({ t: "done", id: m.job.id, leaseId: m.job.leaseId!, ...r });
    })().catch((e) => {
      send({ t: "done", id: m.job.id, leaseId: m.job.leaseId!, ok: false, error: String(e), code: "handler" });
    }).finally(() => running.delete(m.job.id));
    running.set(m.job.id, entry);
    return entry.done;
  };

  // A rejection nobody caught: the process cannot tell which job's code made it. Alone, the job running fails with it
  // (heavy and quarantined executors run one). Beside others, every one is a suspect: given back quarantined, without
  // a try, so the culprit fails alone and its neighbours run again (B2). The process itself keeps going.
  globalThis.addEventListener("unhandledrejection", (ev) => {
    ev.preventDefault();
    const why = `Unhandled rejection: ${ev.reason instanceof Error ? ev.reason.message : String(ev.reason)}`;
    console.error("executor:", why);
    if (running.size === 1) { for (const r of running.values()) r.failed ??= why; }
    else for (const r of running.values()) r.suspect ??= why;
  });

  // stdin is read for the whole life of the process, a heavy one too: abort (cancel, timeout, shutdown) must reach
  // ctx.signal; the kill comes only after the grace (R4).
  const first = Promise.withResolvers<void>();
  let eof = false;
  const reader = (async () => {
    for await (const line of lines(Deno.stdin.readable)) {
      if (!line.startsWith(MARK)) continue;
      const m = JSON.parse(line.slice(MARK.length)) as ToExecutor;
      if (m.t === "run") {
        if (a.kind === "heavy" && running.size) continue;
        void run(m).finally(() => a.kind === "heavy" && first.resolve());
      } else if (m.t === "abort") running.get(m.id)?.ac.abort(new Error(m.reason));
    }
    eof = true;
  })();
  if (a.kind === "heavy") await Promise.race([first.promise, reader]);
  else await reader;
  if (eof) {
    // EOF: the supervisor is gone. Nothing is acked from here; the leases lapse and another node takes over.
    for (const r of running.values()) r.ac.abort(new Error("shutdown"));
    await Promise.race([
      Promise.allSettled([...running.values()].map((r) => r.done)),
      new Promise((r) => setTimeout(r, EOF_GRACE_MS)),
    ]);
  }
  app.tracer.flush();
  return 0;
}
