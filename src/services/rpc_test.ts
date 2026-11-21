import { assert, assertEquals, assertRejects } from "@std/assert";
import { socketPath, sweepSockets } from "./socket.ts";
import { ApiError } from "../core/errors.ts";
import { callOver, closeClients, serveCalls } from "./rpc.ts";

const req = { service: "s", method: "m", args: [], idem: null };
const opts = { deadlineMs: 2_000, traceparent: null };

async function code(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p, ApiError);
  return e.code!;
}

Deno.test("a call that never reached the serve is service_unavailable; one dropped after it was sent is outcome_unknown (B6)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // No socket at all, then a socket nobody listens on (a dead node's file).
    assertEquals(await code(callOver(`${dir}/none.sock`, req, opts)), "service_unavailable");
    const stale = Deno.listen({ transport: "unix", path: `${dir}/stale.sock` });
    stale.close();
    Deno.writeTextFileSync(`${dir}/stale.sock`, "");
    assertEquals(await code(callOver(`${dir}/stale.sock`, req, opts)), "service_unavailable");

    // Read the request, then hang up without an answer.
    const drop = Deno.listen({ transport: "unix", path: `${dir}/drop.sock` });
    void (async () => {
      for await (const c of drop) {
        await c.read(new Uint8Array(4096));
        c.close();
      }
    })();
    assertEquals(await code(callOver(`${dir}/drop.sock`, req, opts)), "service_outcome_unknown");
    drop.close();

    // An answer that never comes within the deadline.
    const slow = serveCalls(`${dir}/slow.sock`, () => new Promise((r) => setTimeout(r, 1_000)));
    assertEquals(await code(callOver(`${dir}/slow.sock`, req, { ...opts, deadlineMs: 100 })), "service_deadline");
    // The socket is the caller's only door: owner only.
    assertEquals(Deno.statSync(`${dir}/slow.sock`).mode! & 0o777, 0o600);
    await slow.close();
  } finally {
    closeClients();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a pb_data too deep for a socket address listens from a private dir instead, never failing (B4)", async () => {
  const base = await Deno.makeTempDir();
  const deep = `${base}/${"d".repeat(60)}/${"e".repeat(60)}`;
  await Deno.mkdir(deep, { recursive: true });
  try {
    const path = socketPath(deep);
    assert(!path.startsWith(deep), path);
    assertEquals(Deno.statSync(path.slice(0, path.lastIndexOf("/"))).mode! & 0o777, 0o700);
    const s = serveCalls(path, () => Promise.resolve("hi"));
    assertEquals(await callOver(path, req, opts), "hi");
    await s.close();
    assertEquals(socketPath(base).startsWith(base), true);
  } finally {
    closeClients();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test({
  name: "a call in flight when its serve is killed is outcome_unknown, even right after another call (B6)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/s.sock`;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./testdata/rpc_serve.ts", import.meta.url).pathname, path],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    try {
      const out = child.stdout.getReader();
      // "ready", within a deadline: a serve that never comes up fails the test instead of hanging it.
      await within(out.read(), 30_000, "rpc serve ready");
      // A first call, so a pooled client would reuse its connection for the next one.
      assertEquals(await callOver(path, req, opts), "ok");
      const inFlight = code(callOver(path, { ...req, method: "hang" }, { ...opts, deadlineMs: 10_000 }));
      await new Promise((r) => setTimeout(r, 300)); // the handler is running
      child.kill("SIGKILL");
      assertEquals(await inFlight, "service_outcome_unknown");
      out.releaseLock();
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* dead */ }
      await child.stdout.cancel().catch(() => {});
      await within(child.status, 10_000, "rpc serve exit").catch(() => {});
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("the sweep removes dead sockets and orphan private dirs, and keeps a live one", async () => {
  const dir = await Deno.makeTempDir();
  const deep = `${dir}/${"d".repeat(60)}/${"e".repeat(60)}`;
  await Deno.mkdir(deep, { recursive: true });
  try {
    // A dead socket in pb_data (pid 1 is never this process).
    Deno.listen({ transport: "unix", path: `${dir}/.svc-1.sock` }).close();
    Deno.writeTextFileSync(`${dir}/.svc-1.sock`, "");
    // An orphan private dir: a socket file with nobody behind it.
    const orphan = socketPath(deep);
    Deno.writeTextFileSync(orphan, "");
    // A live one.
    const live = socketPath(deep);
    const s = serveCalls(live, () => Promise.resolve(1));
    await sweepSockets(dir);
    assertEquals([exists(`${dir}/.svc-1.sock`), exists(orphan.slice(0, orphan.lastIndexOf("/"))), exists(live)], [
      false,
      false,
      true,
    ]);
    await s.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `p` within `ms`, its timer cleared either way: a test never waits on a process forever. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
