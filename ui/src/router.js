import { isSuperuser } from "./pb.js";
import { loadCollections, loadSettings } from "./store.js";
import { closeAllModals, errorState, loading } from "./ui.js";

/**
 * Hash routes under /_/. Each page module exports `render(route)` returning an Element (or a Promise of one).
 * route = { path, params: { name: string }, query: { name: string[] } } (shablon router).
 * Pages are imported lazily, so a broken page never takes the rest of the UI down.
 */
const ROUTES = {
  "#/": () => import("./pages/dashboard.js"),
  "#/records/{collection}": () => import("./pages/records.js"),
  "#/records/{collection}/{id}": () => import("./pages/recordForm.js"),
  "#/logs": () => import("./pages/logs.js"),
  "#/traces": () => import("./pages/traces.js"),
  "#/traces/{id}": () => import("./pages/traces.js"),
  "#/crons": () => import("./pages/crons.js"),
  "#/backups": () => import("./pages/backups.js"),
  "#/notifications": () => import("./pages/notifications.js"),
  "#/oauth": () => import("./pages/oauth.js"),
  "#/settings": () => import("./pages/settings.js"),
};

const GUEST = {
  "#/login": () => import("./pages/login.js"),
};

let bootstrapped = false;

/** Loads what the shell needs once per session (collections for the sidebar, settings for the app name). */
export async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  await Promise.all([loadCollections(), loadSettings()]).catch((err) => {
    bootstrapped = false;
    throw err;
  });
}

/** Forget the session bootstrap (logout). */
export function resetBootstrap() {
  bootstrapped = false;
  app.store.collections = [];
  app.store.settings = null;
}

let seq = 0;

async function show(load, route, guest) {
  const mine = ++seq;
  closeAllModals();
  app.store.path = globalThis.location.hash || "#/";
  app.store.showShell = !guest;
  app.store.page = loading();
  try {
    if (!guest) await bootstrap();
    const mod = await load();
    const el = await mod.render(route);
    if (mine === seq) app.store.page = el;
  } catch (err) {
    console.error(err);
    if (mine === seq) app.store.page = errorState(err, () => show(load, route, guest));
  }
}

export function initRouter() {
  const defs = {};
  for (const [path, load] of Object.entries(ROUTES)) {
    defs[path] = (route) => {
      if (!isSuperuser()) {
        globalThis.location.hash = "#/login";
        return;
      }
      show(load, route, false);
    };
  }
  // The old collections list is gone (each collection page links its API and schema): send it home.
  defs["#/collections"] = () => go("#/");
  for (const [path, load] of Object.entries(GUEST)) {
    defs[path] = (route) => {
      if (isSuperuser()) {
        globalThis.location.hash = "#/";
        return;
      }
      show(load, route, true);
    };
  }
  // Opened by GET /oauth/authorize with or without a session here: no shell, no bootstrap, no login redirect; the
  // page itself decides (hand the session over, or go straight back).
  defs["#/oauth-handoff"] = (route) => show(() => import("./pages/oauthHandoff.js"), route, true);
  return router(defs, { fallbackPath: "#/" });
}

/** Navigate to a hash route, e.g. go("#/records/users"). */
export function go(path) {
  globalThis.location.hash = path;
}
