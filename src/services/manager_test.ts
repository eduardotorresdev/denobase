import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { App } from "../app.ts";
import { ServiceManager } from "./manager.ts";
import { ensureServiceTables } from "./table.ts";
import type { ServiceCtx, ServiceStatus } from "./types.ts";

const timing = { beatMs: 50, recheckMs: 50, stopTimeoutMs: 200 };

/** A manager of one serve over a shared aux db (singletons take the lease, the node beats). */
function node(aux: DatabaseSync, id: string): ServiceManager {
  return new ServiceManager({
    app: () => ({}) as App,
    aux: () => aux,
    role: () => "serve",
    node: () => id,
    shared: () => true,
    timing,
  });
}

function shared(): DatabaseSync {
  const aux = new DatabaseSync(":memory:");
  ensureServiceTables(aux);
  return aux;
}

const state = (m: ServiceManager, name: string) => m.list().find((s) => s.name === name)?.state;

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A service that counts its live instances and hands out its ctx. */
function counted() {
  const ctxs: ServiceCtx[] = [];
  let live = 0, maxLive = 0;
  return {
    ctxs,
    get live() {
      return live;
    },
    get maxLive() {
      return maxLive;
    },
    impl: {
      start: (ctx: ServiceCtx) => {
        ctxs.push(ctx);
        live++;
        maxLive = Math.max(maxLive, live);
      },
      stop: () => {
        live--;
      },
      ping: () => "pong",
    },
  };
}

Deno.test("a service that keeps crashing soon after it is up reaches fatal; a stable run resets the count", async () => {
  const aux = shared();
  const m = node(aux, "a");
  try {
    const s = counted();
    await m.provide("flaky", s.impl, { startSecs: 0, backoffMs: 5, maxBackoffMs: 5, maxRetries: 3, stableSecs: 60 });
    // Up (running), then crashes a moment later, over and over: never stable, so the count only grows.
    for (let i = 0; i < 4; i++) {
      await until(`run ${i}`, () => state(m, "flaky") === "running" && s.ctxs.length === i + 1);
      s.ctxs[i].crashed(new Error("dropped"));
    }
    await until("fatal", () => state(m, "flaky") === "fatal");
    assertEquals(m.list()[0].retries, 4);

    const t = counted();
    await m.provide("steady", t.impl, { startSecs: 0, backoffMs: 5, maxRetries: 1, stableSecs: 0.05 });
    for (let i = 0; i < 3; i++) {
      await until(`steady run ${i}`, () => state(m, "steady") === "running" && t.ctxs.length === i + 1);
      await new Promise((r) => setTimeout(r, 80));
      t.ctxs[i].crashed();
    }
    // Every crash came after a stable window: one in a row each time, never fatal.
    await until("back up", () => state(m, "steady") === "running" && t.ctxs.length === 4);
  } finally {
    await m.close();
  }
});

Deno.test("a crash reported by the service's own stop, or by an old run, does not restart it", async () => {
  const aux = shared();
  const m = node(aux, "a");
  try {
    const s = counted();
    const impl = { ...s.impl, stop: () => (s.impl.stop(), s.ctxs.at(-1)!.crashed(new Error("closed"))) };
    await m.provide("wa", impl, { startSecs: 0, backoffMs: 5 });
    await until("running", () => state(m, "wa") === "running");
    await m.stop("wa");
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(state(m, "wa"), "stopped");
    await m.start("wa");
    await until("running again", () => state(m, "wa") === "running");
    // The first run's ctx is stale: its crash is ignored.
    s.ctxs[0].crashed();
    await new Promise((r) => setTimeout(r, 100));
    assertEquals([state(m, "wa"), s.ctxs.length], ["running", 2]);
  } finally {
    await m.close();
  }
});

Deno.test("a stop that outlives its timeout is awaited by the next start: never two instances", async () => {
  const aux = shared();
  const m = node(aux, "a");
  try {
    let live = 0, maxLive = 0;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    await m.provide("slow", {
      start: () => void (live++, (maxLive = Math.max(maxLive, live))),
      stop: async () => {
        await slow;
        live--;
      },
    }, { startSecs: 0 });
    await m.stop("slow");
    const started = m.start("slow");
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(state(m, "slow"), "stopping");
    release();
    await started;
    assertEquals([state(m, "slow"), maxLive], ["running", 1]);
  } finally {
    await m.close();
  }
});

Deno.test("a singleton that loses its lease steps back to standby (never backoff) and serves no call", async () => {
  const aux = shared();
  const m = node(aux, "a");
  try {
    const s = counted();
    await m.provide("wa", s.impl, { startSecs: 0, backoffMs: 5 });
    await until("running", () => state(m, "wa") === "running");
    // Another serve took the lease over while this one stalled; then its session drops ("replaced").
    aux.prepare(`UPDATE _service_leases SET node = 'b', until = ? WHERE name = 'wa'`).run(Date.now() + 60_000);
    await assertRejects(() => m.execute("wa", "ping", []), Error, "no longer holds");
    s.ctxs[0].crashed(new Error("session replaced"));
    const seen = new Set<ServiceStatus>();
    const off = m.onChange(() => seen.add(state(m, "wa")!));
    await until("standby", () => state(m, "wa") === "standby");
    await new Promise((r) => setTimeout(r, 150));
    off();
    assert(!seen.has("backoff"), [...seen].join());
    assertEquals([state(m, "wa"), s.live], ["standby", 0]);
    // The other serve goes away: this one takes it back.
    aux.prepare(`UPDATE _service_leases SET until = 0 WHERE name = 'wa'`).run();
    await until("running again", () => state(m, "wa") === "running");
  } finally {
    await m.close();
  }
});

Deno.test("stopping a singleton is the cluster's: the standby does not take it over; a start anywhere lifts it", async () => {
  const aux = shared();
  const a = node(aux, "a"), b = node(aux, "b");
  try {
    const sa = counted(), sb = counted();
    await a.provide("wa", sa.impl, { startSecs: 0 });
    await b.provide("wa", sb.impl, { startSecs: 0 });
    await until("a runs, b waits", () => state(a, "wa") === "running" && state(b, "wa") === "standby");
    // Stopped from b's admin: a (the holder) stops at its next beat, and b does not take over.
    await b.stop("wa");
    await until("a stopped", () => state(a, "wa") === "stopped");
    await new Promise((r) => setTimeout(r, 200));
    assertEquals([state(a, "wa"), state(b, "wa"), sb.ctxs.length], ["stopped", "stopped", 0]);
    // Started from b: the holder starts it.
    await b.start("wa");
    await until("a runs again", () => state(a, "wa") === "running");
    assertEquals(state(b, "wa"), "standby");
    // The stop dies with its node: a goes away stopped, b takes over.
    await a.stop("wa");
    await a.close();
    aux.prepare(`UPDATE _service_leases SET until = 0`).run();
    await b.start("wa");
    await until("b runs", () => state(b, "wa") === "running");
  } finally {
    await a.close();
    await b.close();
  }
});
