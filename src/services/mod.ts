/** Long services (§18): a supervisord-like manager, independent of the queue; a call from another process is one request over
 * a Unix socket in pb_data. */
export { type Remote, service, type ServiceHandle } from "./handle.ts";
export { type CurrentCall, currentCall, ServiceManager } from "./manager.ts";
export type {
  CallOptions,
  ProvideOptions,
  RestartPolicy,
  ServiceCtx,
  ServiceImpl,
  ServiceOptions,
  ServiceState,
  ServiceStatus,
} from "./types.ts";
