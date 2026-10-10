import { isSuperuser } from "../pb.js";
import { loading } from "../ui.js";

/**
 * #/oauth-handoff?txn=…: opened by GET /oauth/authorize, once per request, without a click. With a superuser session
 * here, hands it to the pending authorization (POST /oauth/handoff) and follows the URL it answers; with none, or on
 * any error, goes straight back to the request, which then shows its login page. Shows nothing but a neutral loading
 * state: no account, no collection, no error.
 */
/**
 * The answered URL on this origin: the request's binding cookie lives here, while the answer is built on
 * settings.meta.appURL, which may name another host or port (a dev server on another port, a proxy).
 */
function sameOrigin(url) {
  if (typeof url !== "string" || !URL.canParse(url)) return "";
  const u = new URL(url);
  return u.pathname === "/oauth/authorize" ? u.pathname + u.search : "";
}

export function render(route) {
  app.store.title = "OAuth";
  const txn = route?.query?.txn?.[0] || "";
  const back = `/oauth/authorize?txn=${encodeURIComponent(txn)}`;
  const go = (url) => globalThis.location.replace(url);
  if (!txn || !isSuperuser()) {
    go(back);
  } else {
    app.pb.send("/oauth/handoff", { method: "POST", body: { txn } })
      .then((res) => go(sameOrigin(res?.url) || back))
      .catch(() => go(back));
  }
  return loading("");
}
