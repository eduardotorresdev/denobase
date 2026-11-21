import type { App } from "../app.ts";
import type { CallOptions, Methods, ProvideOptions, ServiceImpl, ServiceOptions } from "./types.ts";

/** The handle's methods: each returns a promise, wherever the service lives. */
export type Remote<M extends Methods> = {
  [K in keyof M]: (...args: Parameters<M[K]>) => Promise<Awaited<ReturnType<M[K]>>>;
};

export type ServiceHandle<M extends Methods> = Remote<M> & {
  readonly name: string;
  /** Registers the implementation on `app` (a serve): autostarted, stopped on terminate. Elsewhere a no-op. */
  provide(app: App, impl: ServiceImpl<M>, opts?: ProvideOptions): Promise<void>;
  /** The methods bound to an app (outside a job, when more than one app runs in the process). */
  on(app: App): Remote<M>;
  with(opts: CallOptions): Remote<M> & { on(app: App): Remote<M> };
};

/** Apps that provide a service in this process, so a call without .on(app) outside a job finds one. */
const providers = new Map<string, App>();
/** The app of the job running in this async context (the app plugs it in: src/services knows no queue). */
let ambient: () => App | undefined = () => undefined;

export function setAmbientApp(fn: () => App | undefined): void {
  ambient = fn;
}

function appFor(explicit: App | undefined, name: string): App {
  const app = explicit ?? ambient() ?? providers.get(name);
  if (!app) throw new Error(`service ${name}: no app to call it from; call it inside a job or through ${name}.on(app)`);
  return app;
}

/**
 * Declares a long service by name; the handle is shared by both sides (a module the setup and the serve import).
 * Where the service runs a call is direct; anywhere else it is one request to the serve that runs it (§18).
 */
export function service<M extends Methods>(name: string, opts: ServiceOptions<M> = {}): ServiceHandle<M> {
  const so = opts as ServiceOptions<Methods>;
  const bound = (app: App | undefined, co: CallOptions): Remote<M> =>
    new Proxy({} as Remote<M>, {
      get: (_t, method) => {
        if (typeof method !== "string" || method === "then") return undefined;
        return (...args: unknown[]) => appFor(app, name).services.call(name, method, args, so, co);
      },
    });
  const handle = {
    name,
    provide: (app: App, impl: ServiceImpl<M>, po: ProvideOptions = {}) => {
      if (app.services.runsServices) providers.set(name, app);
      app.onTerminate(() => {
        if (providers.get(name) === app) providers.delete(name);
      });
      return app.services.provide(name, impl as ServiceImpl<Methods>, po);
    },
    on: (app: App) => bound(app, {}),
    with: (co: CallOptions) => Object.assign(bound(undefined, co), { on: (app: App) => bound(app, co) }),
  };
  return new Proxy(handle as unknown as ServiceHandle<M>, {
    get: (t, p) => {
      if (p in t) return (t as unknown as Record<string | symbol, unknown>)[p];
      if (typeof p !== "string" || p === "then") return undefined;
      return (...args: unknown[]) => appFor(undefined, name).services.call(name, p, args, so, {});
    },
  });
}
