import PocketBase, { LocalAuthStore } from "../libs/pocketbase.es.mjs";

globalThis.app = globalThis.app || {};

/** The SDK instance every page uses (PB UI's app.pb). Auth persists in localStorage under its own key. */
globalThis.app.pb = new PocketBase(globalThis.location.origin, new LocalAuthStore("denobase_auth"));

/** True when a superuser session is loaded. */
export function isSuperuser() {
  return app.pb.authStore.isValid && app.pb.authStore.record?.collectionName === "_superusers";
}

/** Error message from an SDK ClientResponseError (or anything thrown). */
export function errMessage(err) {
  return err?.response?.message || err?.message || String(err);
}

/** Field errors of a 400 (`{ field: message }`), for forms. */
export function fieldErrors(err) {
  const out = {};
  for (const [k, v] of Object.entries(err?.response?.data || {})) out[k] = v?.message || String(v);
  return out;
}

app.pb.authStore.onChange(() => {
  if (!isSuperuser() && globalThis.location.hash !== "#/login") globalThis.location.hash = "#/login";
});
