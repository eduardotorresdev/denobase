// Public API of @denobase/denobase: what a consumer extends. Test helpers live in "@denobase/denobase/testing".
export * from "./src/core/types.ts";
export * from "./src/core/infer.ts";
export { z } from "zod";
export * from "./src/core/db.ts";
export * from "./src/core/errors.ts";
export * from "./src/core/define.ts";
export * from "./src/core/registry.ts";
export * from "./src/core/superusers.ts";
export * from "./src/schema/mod.ts";
export * from "./src/query/mod.ts";
export {
  collectionBySlug,
  create,
  find,
  type FindArgs,
  findById,
  type ListResult,
  makeReq,
  overrideDeps,
  type QueryArgs,
  remove,
  update,
  validate,
  type WriteArgs,
} from "./src/engine/mod.ts";
/** The whole record engine (query/count included) for callers below the store. */
export * as engine from "./src/engine/mod.ts";
export { onRecordEvent, type RecordAction, type RecordEvent, type RecordListener } from "./src/engine/events.ts";
export { fieldSchema } from "./src/engine/validate.ts";
export * from "./src/store/mod.ts";
export * from "./src/view/mod.ts";
export {
  type Client,
  type DisconnectHook,
  isSameAuth,
  parseSubscription,
  type PublishOptions,
  Realtime,
  type SubscribeGuard,
  type SubscribeHook,
  type SubscriptionOptions,
  type TopicAccess,
} from "./src/realtime/mod.ts";
export { type App, type AppOptions, createApp } from "./src/app.ts";
export {
  DEFAULT_SETTINGS,
  defaultSettings,
  mergeSettings,
  publicSettings,
  resolveSettings,
  type Settings,
  type SettingsPatch,
} from "./src/settings/mod.ts";
export {
  type BlobBody,
  type BlobInfo,
  type BlobMeta,
  type BlobObject,
  type BlobRange,
  type BlobStore,
  FsStorage,
  MemoryStorage,
  type Storage,
} from "./src/files/storage.ts";
export { CurrentStorage, storageFromSettings } from "./src/files/current.ts";
export { MULTIPART_THRESHOLD, S3Storage } from "./src/files/s3/storage.ts";
export { S3Client, S3Error } from "./src/files/s3/client.ts";
export { Cron, type CronTrigger, type Job, Schedule } from "./src/cron/mod.ts";
export * from "./src/jobs/mod.ts";
export { dbPath, runTask, type Task } from "./src/workers/mod.ts";
export { LEVEL, type Log, Logs } from "./src/logs/mod.ts";
/** Native tracing (app.tracer, app.traces): OTel-shaped spans in the auxiliary db, W3C traceparent. */
export {
  type Attrs,
  currentTrace,
  formatTraceparent,
  parseTraceparent,
  Span,
  type SpanContext,
  SpanKind,
  type SpanNode,
  type SpanRecord,
  Spans,
  SpanStatus,
  type StoredSpan,
  traced,
  tracedFetch,
  Tracer,
  type TraceSettings,
  type TraceStats,
  type TraceSummary,
} from "./src/telemetry/mod.ts";
export { type BackupInfo, Backups } from "./src/backups/mod.ts";
export { type AppEnv, tokenFromHeader } from "./src/http/app.ts";
export { authed, type AuthedCtx, type AuthedOptions } from "./src/http/guard.ts";
export { ReadOnlySqlError, selectRows } from "./src/sql/read.ts";
export {
  guardedQuery,
  type GuardLayer,
  type GuardLimits,
  type GuardOptions,
  type GuardResult,
  SqlRejected,
} from "./src/sql/guard.ts";
export * from "./src/auth/password.ts";
export * from "./src/auth/otp.ts";
export * from "./src/auth/alert.ts";
export * from "./src/auth/mailer.ts";
export { publicAuthRecord, signAuthToken, type TokenClaims, verifyAuthToken } from "./src/auth/jwt.ts";
export * as migrations from "./src/migrations/mod.ts";
/** Native notifications (provider registry, send log, WhatsApp Web): notifications.register(app), .collections. */
export * as notifications from "./src/notifications/index.ts";
export { MIGRATIONS_DIR, setMigrationsDir } from "./src/migrations/mod.ts";
export {
  Cli,
  type Command,
  type CommandContext,
  createCli,
  DEFAULT_DB,
  defaultCommands,
  genesis,
  genesisCommand,
  genesisPreflight,
  INSTALLER_EMAIL,
  migrateCommand,
  parseArgs,
  reconcileCommand,
  runGenesis,
  serve,
  serveCommand,
  type ServeOptions,
  testData,
  testDataCommand,
  UsageError,
} from "./src/cli/mod.ts";
export * from "./src/mcp/mod.ts";
export * from "./src/oauth/mod.ts";
export { onExternalCommit, syncExternalCommits } from "./src/core/coherence.ts";
