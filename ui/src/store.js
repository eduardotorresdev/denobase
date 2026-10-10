globalThis.app = globalThis.app || {};

/** Global reactive state (PB UI's app.store). Pages read/write it; the shell renders from it. */
globalThis.app.store = store({
  /** Current page element, set by the router. */
  page: null,
  /** false on guest pages (login): no sidebar. */
  showShell: false,
  /** Page title, shown in the header and the tab. */
  title: "",
  /** /api/settings, loaded after login (null until then). */
  settings: null,
  /** /api/collections items, sorted by name. */
  collections: [],
  collectionsLoading: false,
  /** [{ id, type: "info"|"success"|"error", message }] (use ui.toast()). */
  toasts: [],
  /** Current route path (e.g. "#/collections/users"), for nav highlighting. */
  path: "",
  /** Signed-in superuser email (kept in sync by main.js). */
  authEmail: "",
});

watch(() => {
  const name = app.store.settings?.meta?.appName;
  document.title = [app.store.title, name, "Denobase"].filter(Boolean).join(" · ");
});

/** Reloads app.store.collections (system ones last). */
export async function loadCollections() {
  app.store.collectionsLoading = true;
  try {
    const list = await app.pb.collections.getFullList({ sort: "name" });
    list.sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
    app.store.collections = list;
  } finally {
    app.store.collectionsLoading = false;
  }
}

/** Reloads app.store.settings. */
export async function loadSettings() {
  app.store.settings = await app.pb.settings.getAll();
}

/** Collection by id or name from the loaded list. */
export function findCollection(idOrName) {
  return app.store.collections.find((c) => c.id === idOrName || c.name === idOrName) || null;
}
