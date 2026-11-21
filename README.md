# denobase

A PocketBase-compatible backend on Deno 2. Collections are declared in TypeScript, migrations are diffed from them, and
the REST API, realtime (SSE), auth flows, files, batch, crons, backups and logs answer like PocketBase (pinned at
v0.39.10), so the PocketBase JS SDK works against it. It runs on `node:sqlite` with parameterized SQL and Hono, and
ships an admin UI at `/_/`, a native MCP server (`POST /api/mcp`) with its own OAuth 2.1 authorization server, and
OTel-shaped tracing.

## Install

```sh
deno add jsr:@denobase/denobase
```

Import it under the bare key `denobase` (what `deno add` writes to your `deno.json`):

```json
{ "imports": { "denobase": "jsr:@denobase/denobase@^0.4.1" } }
```

## Usage

`main.ts`, the entry point of your backend:

```ts
import { createCli, defineCollection, registerCollections, setMigrationsDir } from "denobase";

export const posts = defineCollection({
  slug: "posts",
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "text" },
  ],
  access: {
    read: () => true,
    create: ({ user }) => !!user,
  },
});

registerCollections(posts);
setMigrationsDir(new URL("./migrations/", import.meta.url));

const cli = createCli({ settings: { meta: { appName: "My app" } } });
Deno.exit(await cli.run(Deno.args));
```

```sh
deno run -A main.ts migrate create   # writes a migration diffed from the declared collections
deno run -A main.ts serve --port 8090
```

`serve` applies pending migrations, keeps its data in `pb_data/` and serves the API at `http://localhost:8090/api/` and
the admin UI at `http://localhost:8090/_/`. `cli.add(command)` adds or replaces CLI commands; `createApp({ db })` builds
an app without the CLI (tests, custom servers). Test helpers live in `denobase/testing`
(`jsr:@denobase/denobase/testing`).

## Permissions

The server needs:

- `--allow-net`: the HTTP listener and outbound calls (mail through Resend, OAuth client metadata, WhatsApp).
- `--allow-read` and `--allow-write`: the db, `pb_data/` (storage, backups, auxiliary db) and the migrations dir.
- `--allow-env`: configuration such as `PORT`, `DB_PATH`, `APP_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `MAIL_FROM`,
  `RESEND_API_KEY`, `DENOBASE_ORIGINS`, `DENOBASE_UI=off` (no admin UI) and `DENOBASE_WORKER=0` (no embedded worker).

- `--allow-run`: the queue's executors are subprocesses of the same program.

Executors get `createCli({ executorFlags })`, else `DENOBASE_EXECUTOR_FLAGS`, else `-A` (Deno does not expose the
parent's flags). `-A` is the simple choice for a server you control.

## Background work: one queue

Everything that runs outside a request goes through one queue persisted in the db (`_jobs`): jobs you define, schedules
(crons only enqueue), backups and the files migration. A job is claimed atomically under a lease with heartbeat, acked
or retried with backoff up to its attempt limit, and stays visible when it fails (the admin's Queue page: retry, cancel,
remove).

- `serve` runs HTTP, the scheduler, the long services and an embedded worker (`--no-worker` or `DENOBASE_WORKER=0` turns
  the worker off; `--queues`, `--concurrency`, `--heavy-concurrency` size it).
- `worker` processes consume the same db file, as many as you like: `worker --queues normal --concurrency 8`,
  `worker --queues heavy`. A heavy job (a backup) runs in its own process and never takes a normal slot.
- A clean stop (SIGTERM, SIGINT, a restore) waits for the running jobs up to a grace (30 s for `worker`, 10 s for
  `serve`; `DENOBASE_STOP_GRACE_MS` sets it), then gives the rest back with no try spent, as `stopped`. Keep the grace
  under your orchestrator's stop timeout: a process killed before that leaves its jobs to lapse, and the lapse spends a
  try.
- An in-memory db runs jobs inline after the commit. A bare `createApp` on a db file (a script) only enqueues: nodes run
  the jobs. Consuming there is explicit: `app.queue.drain()` (refused while a node is live), or `app.queue.run()` of its
  own job when no node is up. Tests call `app.queue.drain()`.
- A worker refuses to start with pending migrations, and exits with 75 while a backup is restored (let your process
  manager restart it).

### Long services

A long service (a WhatsApp session, a socket to a device) is not a job: it lives in the serve, under a supervisord-like
lifecycle (starting, running, backoff, fatal, stopped, standby), shown on the admin's Services page with start, stop and
restart. `singleton` (the default) runs it on one serve at a time; stopping one is the cluster's decision until a start
from any serve. The scheduler is one of them: stopped, it is an alarm on the Queue page.

A call from another process (a job in a worker) is one direct request to the serve that runs it, over a Unix socket in
pb_data. Nothing is kept and nothing is retried; the failures say what happened:

| Code                      | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `service_unavailable`     | no serve runs it now, or the request never reached one: it did not run        |
| `service_deadline`        | no answer within the deadline (`with({ deadlineMs })`, default 30 s)          |
| `service_outcome_unknown` | the connection dropped after the request was sent: it may or may not have run |
| `service_call_in_tx`      | called inside a transaction: call it after the commit                         |

A job that fails is retried, and its calls run again. Each call carries an idempotency key, the same on every retry
(`<job>:<service.method>:<hash of the arguments>:<k-th such call>`; `with({ idem })` replaces it with a business id),
read in the method with `currentCall()?.idem`. **A service with an external effect deduplicates by it**: it keeps the
key with the effect and answers a repeated key from what it kept. `notifications` does: the row of a send stores the
key, and a retry gets the sent row back; only a failed or never-finished send goes out again. Sending holds the row
(`sender`, `sendUntil`, taken in one transaction and renewed while it sends), so a retry routed to another serve waits
for that send instead of sending too; a hold whose serve died lapses after 30 s and is taken over. Writing the outcome
is retried apart from the send: a busy database never sends twice. **One window stays at-least-once**: a serve killed
after the provider accepted the message and before the row says `sent` leaves it held; once the hold lapses the retry
sends it again. No provider confirms "already sent" by our key, so closing it would need the provider's own dedupe.

```ts
// setup.ts: runs in every process (serve, worker executors, mcp)
import { type App, defineSetup, enqueue, service } from "denobase";

export const whatsapp = service<{ send(to: string, text: string): Promise<{ id: string }> }>("whatsapp");

export default defineSetup((app: App) => {
  // 1. a job: every top-level transaction in it is fenced on its lease
  app.queue.define<{ phone: string }>("invoice.send", async (ctx) => {
    // 5. a long service of the serve, from a job anywhere (a direct call; the same key on a retry)
    await whatsapp.send(ctx.payload.phone, "Your invoice is out");
  }, { maxAttempts: 5 });
  // 2. a schedule: it only enqueues, never over a run still pending or running
  app.queue.schedule("closing", "0 3 * * *", "invoice.send", { phone: "+5511999999999" });
});
```

```ts
// main.ts
import { createCli, currentCall } from "denobase";
import { whatsapp } from "./setup.ts";

await createCli({
  setup: new URL("./setup.ts", import.meta.url),
  beforeServe(app) {
    // 4. a long service: serve only, with its state in the admin
    whatsapp.provide(app, {
      start: () => session.connect(),
      stop: () => session.close(),
      status: () => session.state,
      // External effect: deduplicated by the call's key, so a retried job does not send twice.
      send: async (to, text) => {
        const key = currentCall()?.idem;
        const kept = key ? await sent.get(key) : null;
        if (kept) return kept;
        const r = await session.send(to, text);
        if (key) await sent.set(key, r);
        return r;
      },
    });
  },
}).run(Deno.args);
```

```ts
// 3. enqueue from a route: atomic with the write
await req.store.tx(async (tx) => {
  const order = await tx.collection(orders).create(body);
  await enqueue(tx, "invoice.send", { phone: body.phone, order: order.id });
});
```

### Migrating from 0.3

| Before                                                                    | After                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `app.jobs.use(new URL("./bootstrap.ts", …))`                              | `createCli({ setup: new URL("./setup.ts", …) })` (or `createApp({ setup })`)                      |
| bootstrap `export default (app) => …`                                     | `export default defineSetup((app) => …)`                                                          |
| `defineJob(id, (ctx) => …)`                                               | `app.queue.define(name, (ctx) => …, opts)` in the setup                                           |
| `cron.addJob(id, expr, { job: id }, input)`                               | `app.queue.schedule(id, expr, name, payload?)`; a per-run `input()` becomes a read in the handler |
| `cron.addJob(id, expr, { module })` / `cron.addTask(id, expr, module)`    | `define(name, fn, { queue: "heavy" })` + `schedule`                                               |
| `cron.add(id, expr, fn)` (main thread)                                    | removed with `app.cron`: scheduled work is a job, main-thread work a long service                 |
| `cron.jobs()` / `cron.get(id).run("manual")` / `job.running`              | `app.queue.schedules()` / `app.queue.runNow(id)` / the schedule's last job (`app.queue.list`)     |
| `runTask(module, input)` / `app.jobs.run(spec, input)`                    | `app.queue.run(name, payload)` (waits) or `app.queue.enqueue` (does not)                          |
| `onMain(name, fn)` / `app.jobs.operation(name, fn)` / `ctx.call(name, …)` | `const s = service<M>(name)`; `s.provide(app, impl)` on the serve; `s.method(…)` from anywhere    |
| `ctx.input`                                                               | `ctx.payload`                                                                                     |
| `ctx.inWorker` / `inJobWorker()`                                          | removed; `currentJob()` says whether a job runs                                                   |
| `DENOBASE_JOBS_INLINE=1`                                                  | removed; `serve --no-worker` / `DENOBASE_WORKER=0`; in memory jobs always run inline              |
| `Backups.active`                                                          | the pending or running backup job (dedupe key `backups`)                                          |
| `notifications.register(app)` in a job process                            | the same call: outside the serve, `send`/`retry` call the serve's `notifications` service         |
| a script with `createApp` on the production file ran due jobs inline      | it only enqueues; `app.queue.drain()` to consume (refused while a node is live)                   |
| `_notifications` without `idem`                                           | the migration adds `idem` (unique when set): the key of the send's call                           |
| `_notifications` without `sender`/`sendUntil`                             | the migration adds them: who holds a queued row while it sends, and until when                    |

## Documentation

- [AGENTS.md](./AGENTS.md): the conventions and the shape of the public API.
- [CONTRACTS.md](./CONTRACTS.md): what each module exposes and depends on.
- `mod.ts` is the public API; anything a consumer needs is exported from it.

## License

MIT, see [LICENSE](./LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
