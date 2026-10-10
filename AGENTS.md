# denobase (`@denobase/denobase`)

A PocketBase-compatible backend on Deno 2: Hono, `node:sqlite`, own parameterized SQL, collections declared in code,
migrations diffed from them, PB-compatible REST and auth. It knows no domain: a consumer registers its collections
(`registerCollections`), migrations dir (`setMigrationsDir`) and test template (`setTemplateDb`), and builds its CLI
with `createCli()`, adding or replacing commands with `cli.add`.

- One `App` per process (`createApp({ db })`) builds the one store; code receives it, never builds its own: hooks and
  access fns use `req.store`, `beforeServe` gets the app, factories take the store. Records go through
  `store.collection(config)` and its query builder, never raw SQL; `src/store/sqlite.ts` is the only record SQL.
  Validation is zod (`z` is re-exported).
- Raw SQL outside `src/store/sqlite.ts` has two doors only. `selectRows(db, sql, params)` is the read/aggregation path
  for what the query builder cannot say (JOIN across collections, `json_each` over hasMany/json, GROUP BY): one
  SELECT/WITH, values as params, identifiers via `quoteIdent`/`tableName`; an authorizer refuses writes, PRAGMA and DDL;
  it skips access rules, so check access first. `guardedQuery(path, sql, params, opts)` runs untrusted read SQL (the
  assistant's sqlguard) in a worker on a read-only connection with allowlist, row/byte caps and a timeout that
  terminates the worker. Writes always go through the store.
- Collection access follows PB rules exactly. An op left out of `access`, or set to `LOCKED`, is a nil rule: superusers
  only, everyone else 403 "Only superusers can perform this action.". A fn returning false is a rule that matched
  nothing: list 200 with empty items, view/update/delete 404, create 400 "Failed to create record.", protected file 404,
  realtime event dropped. A fn returning a Where is ANDed in; a fn returning `LOCKED` is the nil rule for that call (PB
  list rule set, view rule nil: `({ id }) => (id ? LOCKED : true)`). Never 403 for a guest against an auth rule.
- Custom routes of a consumer wrap their handler in `authed(app, { allow })` (401/403, superuser passes) and refuse
  domain cases with `stableError`/`stableBadRequest`/`stableUnprocessable`/`stableForbidden`: PB JSON with the stable
  snake_case `data.code`; `CODE_PERMISSION_DENIED` (`permissao_negada`) is every authorization 403.
- Custom realtime topics: `app.realtime.publish(topic, data, { access })`: exact topic match, authenticated clients by
  default, sent after commit. Mail: `Mail` takes to/cc/bcc lists, replyTo, attachments, headers.
- MCP is native (`src/mcp/`): `POST /api/mcp` (Streamable HTTP, both protocol eras) and the `mcp` CLI command (stdio,
  superuser unless `--as <email>`). The consumer extends it through `app.mcp.tool`, `resource`, `resourceTemplate` and
  `prompt` (zod input, `visibility`/`allow`); handlers get `ctx.store` = `app.store.as(user)`, so access rules apply as
  on REST, and a thrown `ApiError` becomes `isError` with its stable code. Built-ins are prefixed `db_`.
- OAuth for the MCP is native (`src/oauth/`): the app is its own authorization server. A client (DCR, an https client_id
  document, or `McpOptions.oauth.clients`) sends the user to `/oauth/authorize`; the user signs in and approves on
  server-rendered pages (own httpOnly cookie, no SPA), and the client gets the app's auth JWT (`aud` =
  `<appURL>/api/mcp`, claims `scope`/`cid`/`gid`) plus a rotating refresh token. Who may authorize is
  `McpOptions.oauth.collections` (default `["_superusers"]`), narrowed by `settings.oauth`; which one a request signs in
  against is picked by whoever launches it (`auth_collection`, else `settings.oauth.defaultCollection`), and the login
  page stays opaque about it (no selector, one generic failure). Scopes (`mcp`, `mcp:read`, `mcp:write`, app scopes)
  only narrow the tools; access rules still decide. Revocation is immediate (`gid` is checked per request).
  `app.mcp.token` stays the manual path for CI and scripts.
- Tracing is native (`src/telemetry/`): `app.tracer.span(name, attrs, fn)` for consumer work; requests, cron runs, SQL,
  tx, hooks, CRUD, batch, realtime, mail, notifications and `app.tracer.fetch` are traced on their own. Spans go to
  `_spans` in the auxiliary db; read them in tests with `collectSpans(app)`.
- REST and realtime must stay 1:1 with PocketBase; check behaviour in the upstream source
  (github.com/pocketbase/pocketbase, pinned at v0.39.10).
- Public API is `mod.ts`; test helpers are `@denobase/denobase/testing` (consumers import the package under the bare key
  `denobase`). Anything a consumer needs goes through them.
- Contracts between modules: `CONTRACTS.md`. Change a contract only with its owner.
- Tasks: `deno task test|check|lint|fmt`. All green, zero warnings.
- The admin UI and the OAuth page assets ship embedded in `src/http/ui_assets.ts` (JSR has no files to read): run
  `deno task embed-ui` after editing `ui/`; a test fails while it is stale. From a local checkout `ui/` is read live.
- Tests build their own collections and tables; nothing here imports a consumer.
- English code. Comments say why.
- Schedules in the admin UI (`ui/`): human controls first. Edit them with `scheduleField` from `ui/src/schedule.js`
  (repeat, then days and times); typing a cron is only its "Custom" fallback for what the controls can't express.
  Display them with `humanizeCron` from `ui/src/cron.js`, the raw cron at most in a tooltip. Storage stays cron.
- Time: stored and sent in UTC (PB). Crons (server `Cron`, UI `nextRun`) and every displayed time use the
  `meta.timezone` setting (IANA, default UTC). In the UI format dates with `ui/src/time.js`, never
  `toLocale*`/`getHours`.
