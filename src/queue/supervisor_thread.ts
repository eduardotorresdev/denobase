/**
 * The serve's supervisor thread (§16 N2): every queue statement of a serve runs here, on connections of its own, so
 * the HTTP thread never waits on a write lock its own open request transaction holds. The main thread only publishes
 * the outbox's events.
 */
import { Supervisor, type SupervisorOptions, type SupervisorState } from "./supervisor.ts";
import type { OutboxEvent } from "./nodes.ts";

export type ToSupervisorThread =
  | { t: "init"; opts: Omit<SupervisorOptions, "events" | "restoring" | "schedulerError">; state: SupervisorState }
  | { t: "state"; state: Partial<SupervisorState> }
  | { t: "wake" }
  | { t: "stop"; graceMs: number };

export type FromSupervisorThread =
  | { t: "started"; catalog: { name: string; queue: string }[] }
  | { t: "events"; events: OutboxEvent[] }
  | { t: "restoring"; why: string }
  | { t: "schedulerError"; error: string }
  | { t: "stopped" };

// No worker lib reference: JSR bans the directive in a module the public graph reaches (runtime.ts imports its types).
const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<ToSupervisorThread>) => unknown) | null;
  close(): void;
};
const post = (m: FromSupervisorThread) => scope.postMessage(m);
let sup: Supervisor | undefined;
let records: BroadcastChannel | undefined;

scope.onmessage = async (e: MessageEvent<ToSupervisorThread>) => {
  const m = e.data;
  if (m.t === "init") {
    // Record events relayed from the outbox reach the main thread's realtime as another thread's writes would.
    records = new BroadcastChannel(`denobase:records:${m.opts.dbPath}`);
    sup = new Supervisor({
      ...m.opts,
      events: (events) => {
        const topics: OutboxEvent[] = [];
        for (const ev of events) {
          if (ev.kind === "record") records!.postMessage({ slug: ev.slug, id: ev.id, action: ev.action, row: ev.row });
          else topics.push(ev);
        }
        if (topics.length) post({ t: "events", events: topics });
      },
      restoring: (why) => post({ t: "restoring", why }),
      schedulerError: (error) => post({ t: "schedulerError", error }),
    });
    sup.update(m.state);
    await sup.start();
    post({ t: "started", catalog: sup.catalog });
  } else if (m.t === "state") sup?.update(m.state);
  else if (m.t === "wake") sup?.wake();
  else if (m.t === "stop") {
    await sup?.stop(m.graceMs);
    records?.close();
    post({ t: "stopped" });
    scope.close();
  }
};
