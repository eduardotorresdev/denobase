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
{ "imports": { "denobase": "jsr:@denobase/denobase@^0.1.0" } }
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
  `RESEND_API_KEY`, `DENOBASE_ORIGINS`, `DENOBASE_UI=off` (no admin UI) and `DENOBASE_JOBS_INLINE=1`.

Workers (jobs, backups, the read-only SQL guard) run with the permissions of the process. `-A` is the simple choice for
a server you control.

## Documentation

- [AGENTS.md](./AGENTS.md): the conventions and the shape of the public API.
- [CONTRACTS.md](./CONTRACTS.md): what each module exposes and depends on.
- `mod.ts` is the public API; anything a consumer needs is exported from it.

## License

MIT, see [LICENSE](./LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
