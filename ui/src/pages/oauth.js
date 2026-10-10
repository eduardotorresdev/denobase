import { badge, confirm, empty, errorState, formatDate, loading, page, toast, toastError } from "../ui.js";

const api = (path, opts = {}) => app.pb.send(path, { method: "GET", ...opts });

const TABS = [
  { id: "clients", label: "Clients" },
  { id: "grants", label: "Access" },
];

const KIND = { dcr: "DCR", cimd: "CIMD", static: "Static" };

/** OAuth (GET/DELETE /api/oauth/clients, /api/oauth/grants): who can reach the MCP, and revocation. */
export function render(route) {
  app.store.title = "OAuth";
  const initial = route?.query?.tab?.[0];
  const data = store({
    tab: TABS.some((x) => x.id === initial) ? initial : "clients",
    clients: [],
    grants: [],
    loading: true,
    error: null,
    busy: {},
    // Access tab: which grants show (active by default) and a text match on user, client or scope.
    status: "active",
    query: "",
  });

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      const [c, g] = await Promise.all([api("/api/oauth/clients"), api("/api/oauth/grants")]);
      data.clients = c.items;
      data.grants = g.items;
    } catch (err) {
      if (!err?.isAbort) data.error = err;
    } finally {
      data.loading = false;
    }
  }

  async function remove(kind, item) {
    const isClient = kind === "clients";
    const ok = await confirm(
      isClient
        ? `Remove "${item.name || item.id}"? Every access it holds is revoked at once.`
        : `Revoke the access of ${item.email || item.recordId} to "${item.clientName || item.clientId}"?`,
      { title: isClient ? "Remove client" : "Revoke access", yes: isClient ? "Remove" : "Revoke", danger: true },
    );
    if (!ok) return;
    data.busy[item.id] = true;
    try {
      await api(`/api/oauth/${kind}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      toast(isClient ? "Client removed." : "Access revoked.", "success");
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      data.busy[item.id] = false;
    }
  }

  /** Revokes every live access of one user (DELETE /api/oauth/grants?collection&recordId). */
  async function revokeUser(g) {
    const who = g.email || g.recordId;
    const n = data.grants.filter((x) => sameUser(x, g) && !x.revokedAt).length;
    const ok = await confirm(`Revoke all ${n} active access${n === 1 ? "" : "es"} of ${who}?`, {
      title: "Revoke all of this user",
      yes: "Revoke all",
      danger: true,
    });
    if (!ok) return;
    try {
      const q = new URLSearchParams({ collection: g.collection, recordId: g.recordId });
      await api(`/api/oauth/grants?${q}`, { method: "DELETE" });
      toast(`Every access of ${who} was revoked.`, "success");
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  const sameUser = (a, b) => a.collection === b.collection && a.recordId === b.recordId;

  function visibleGrants() {
    const q = data.query.trim().toLowerCase();
    return data.grants.filter((g) => {
      if (data.status === "active" && g.revokedAt) return false;
      if (data.status === "revoked" && !g.revokedAt) return false;
      if (!q) return true;
      return [g.email, g.recordId, g.collection, g.clientName, g.clientId, g.scope]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  load();

  const when = (v) => (v ? formatDate(v) : "—");

  function action(kind, item, label) {
    return t.td(
      { className: "actions" },
      t.button({
        className: "btn btn-sm btn-danger",
        disabled: () => !!data.busy[item.id],
        textContent: label,
        onclick: () => remove(kind, item),
      }),
    );
  }

  function table(head, rows) {
    return t.div(
      { className: "table-wrap" },
      t.table(
        { className: "table" },
        t.thead({}, t.tr({}, head.map((h) => t.th({ textContent: h })), t.th({}))),
        t.tbody({}, rows),
      ),
    );
  }

  function clients() {
    if (!data.clients.length) return empty("No client has registered yet.");
    return table(
      ["Name", "Type", "Redirects to", "Active", "Created", "Last used"],
      data.clients.map((c) =>
        t.tr(
          { rid: c.id },
          t.td(
            {},
            t.div({ textContent: c.name || "(no name)" }),
            t.code({ className: "muted", style: "font-size:12px", textContent: c.id }),
          ),
          t.td({}, badge(KIND[c.kind] || c.kind, c.kind === "static" ? "info" : "neutral")),
          t.td({ className: "mono", textContent: c.redirectHosts.join(", ") }),
          t.td({ textContent: String(c.activeGrants) }),
          t.td({ textContent: when(c.created) }),
          t.td({ textContent: when(c.lastUsed) }),
          c.kind === "static"
            ? t.td({
              className: "actions muted",
              style: "font-size:12px",
              title: "Static clients come from McpOptions.oauth.clients in the server's code; remove them there.",
              textContent: "Set in code",
            })
            : action("clients", c, "Remove"),
        )
      ),
    );
  }

  function grantFilters() {
    const chip = (value, label) =>
      t.button({
        className: () => `chip ${data.status === value ? "active" : ""}`,
        textContent: label,
        onclick: () => (data.status = value),
      });
    return t.div(
      { className: "chips", style: "margin-bottom:8px" },
      t.input({
        className: "input",
        style: "max-width:280px",
        placeholder: "Search user, client or scope",
        value: () => data.query,
        oninput: (e) => (data.query = e.target.value),
      }),
      chip("active", "Active"),
      chip("revoked", "Revoked"),
      chip("all", "All"),
    );
  }

  function grants() {
    if (!data.grants.length) return empty("No one has authorized a client yet.");
    // Only the table follows the filters, so typing in the search box keeps its focus.
    return t.div({}, grantFilters(), () => {
      const rows = visibleGrants();
      return rows.length
        ? table(
          ["User", "Client", "Scopes", "Resource", "Created", "Last used"],
          rows.map((g) =>
            t.tr(
              { rid: g.id },
              t.td(
                {},
                t.div({ textContent: g.email || g.recordId }),
                t.span({ className: "muted", style: "font-size:12px", textContent: g.collection }),
              ),
              t.td({ textContent: g.clientName || g.clientId }),
              t.td({ className: "mono", textContent: g.scope }),
              t.td({ className: "mono", style: "font-size:12px", textContent: g.resource }),
              t.td({ textContent: when(g.created) }),
              t.td(
                {},
                g.revokedAt ? badge("revoked", "danger") : t.span({ textContent: when(g.lastUsed) }),
              ),
              t.td(
                { className: "actions" },
                t.button({
                  className: "btn btn-sm btn-danger",
                  disabled: () => !!g.revokedAt || !!data.busy[g.id],
                  textContent: "Revoke",
                  onclick: () => remove("grants", g),
                }),
                t.button({
                  className: "btn btn-sm btn-ghost",
                  hidden: g.revokedAt || data.grants.filter((x) => sameUser(x, g) && !x.revokedAt).length < 2,
                  title: "Revoke every active access of this user",
                  textContent: "All of user",
                  onclick: () => revokeUser(g),
                }),
              ),
            )
          ),
        )
        : empty("No access matches the filter.");
    });
  }

  return page(
    "OAuth",
    t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    t.p({
      className: "muted",
      textContent: "Applications that reach the MCP on behalf of a user. They sign in and approve on this server's " +
        "own page; revoking cuts the access at once.",
    }),
    t.div(
      { className: "tabs" },
      TABS.map((tab) =>
        t.button({
          className: () => `tab ${data.tab === tab.id ? "active" : ""}`,
          textContent: tab.label,
          onclick: () => (data.tab = tab.id),
        })
      ),
    ),
    () => {
      if (data.loading) return loading();
      if (data.error) return errorState(data.error, load);
      return data.tab === "clients" ? clients() : grants();
    },
  );
}
