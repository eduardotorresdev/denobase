import {
  badge,
  confirm,
  empty,
  errorState,
  formatDate,
  loading,
  onUnmount,
  page,
  pager,
  toast,
  toastError,
} from "../ui.js";

const STATE_KIND = {
  connected: "success",
  pairing: "warning",
  connecting: "info",
  disconnected: "neutral",
  logged_out: "danger",
};
const STATUS_KIND = { queued: "neutral", sent: "info", delivered: "accent", read: "success", failed: "danger" };

const api = (path, opts = {}) =>
  app.pb.send(`/api/notifications${path}`, { ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });

/** Providers (enable, WhatsApp pairing, logout, groups) and the send log with retry (/api/notifications). */
export function render(_route) {
  const data = store({
    providers: [],
    wa: null,
    groups: null,
    log: { items: [], page: 1, perPage: 30, totalItems: 0, totalPages: 0 },
    status: "",
    loading: true,
    error: null,
    busy: false,
  });

  async function loadProviders() {
    data.providers = await api("/providers");
    data.wa = data.providers.some((p) => p.id === "whatsapp-web") ? await api("/whatsapp/status") : null;
  }

  async function loadLog(p = data.log.page) {
    const q = new URLSearchParams({ page: String(p), perPage: "30" });
    if (data.status) q.set("status", data.status);
    data.log = await api(`?${q}`);
  }

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      await Promise.all([loadProviders(), loadLog()]);
    } catch (err) {
      if (!err?.isAbort) data.error = err;
    } finally {
      data.loading = false;
    }
  }

  async function act(fn, ok) {
    data.busy = true;
    try {
      await fn();
      if (ok) toast(ok, "success");
      await loadProviders();
    } catch (err) {
      toastError(err);
    } finally {
      data.busy = false;
    }
  }

  const toggle = (p) => act(() => api(`/providers/${p.id}`, { method: "PATCH", body: { enabled: !p.enabled } }), null);
  const logout = async () => {
    if (
      !(await confirm("Unlink this WhatsApp number? Pairing again needs the phone.", { danger: true, yes: "Logout" }))
    ) return;
    await act(() => api("/whatsapp/logout", { method: "POST" }), "WhatsApp session removed.");
  };
  const groups = () => act(async () => data.groups = await api("/whatsapp/groups"), null);
  const retry = (id) =>
    act(async () => {
      await api(`/${id}/retry`, { method: "POST" });
      await loadLog();
    }, "Sent again.");

  load();
  // While pairing the QR rotates every ~20s; poll the status so the page shows the current one.
  const timer = setInterval(() => {
    if (data.wa && data.wa.state !== "connected") loadProviders().catch(() => {});
  }, 3000);

  function whatsappCard() {
    const wa = data.wa;
    if (!wa) return null;
    return t.div(
      { className: "card" },
      t.div(
        { className: "page-actions" },
        t.strong({ textContent: "WhatsApp Web" }),
        badge(wa.state, STATE_KIND[wa.state] || "neutral"),
        wa.account ? t.span({ className: "mono muted", textContent: wa.account }) : null,
      ),
      wa.error ? t.p({ className: "muted", textContent: wa.error }) : null,
      wa.qrSvg
        ? t.div(
          {},
          t.p({ className: "muted", textContent: "Scan with WhatsApp > Linked devices > Link a device." }),
          t.div({ style: "width:240px;height:240px;background:#fff;padding:8px", innerHTML: wa.qrSvg }),
        )
        : null,
      wa.state === "connected"
        ? t.div(
          { className: "page-actions" },
          t.button({ className: "btn btn-sm", textContent: "Groups", disabled: () => data.busy, onclick: groups }),
          t.button({
            className: "btn btn-sm btn-danger",
            textContent: "Logout",
            disabled: () => data.busy,
            onclick: logout,
          }),
        )
        : null,
      data.groups
        ? t.ul(
          {},
          data.groups.map((g) =>
            t.li(
              { rid: g.id },
              t.span({ textContent: `${g.subject} (${g.participants}) ` }),
              t.code({ textContent: g.id }),
            )
          ),
        )
        : null,
    );
  }

  function providerRow(p) {
    return t.tr(
      { rid: p.id },
      t.td({ className: "mono", textContent: p.id }),
      t.td({ textContent: p.channels.join(", ") }),
      t.td({}, badge(p.status.state, STATE_KIND[p.status.state] || "neutral")),
      t.td(
        { className: "actions" },
        t.button({
          className: "btn btn-sm",
          textContent: p.enabled ? "Disable" : "Enable",
          disabled: () => data.busy,
          onclick: () => toggle(p),
        }),
      ),
    );
  }

  function logRow(n) {
    return t.tr(
      { rid: n.id },
      t.td({ className: "mono", textContent: formatDate(n.created) }),
      t.td({ className: "mono", textContent: n.provider }),
      t.td({ className: "mono", textContent: n.to }),
      t.td({ textContent: n.text || (n.media ? `[${n.media.kind}]` : "") }),
      t.td({ title: n.error || "" }, badge(n.status, STATUS_KIND[n.status])),
      t.td({ textContent: String(n.attempts ?? 0) }),
      t.td(
        { className: "actions" },
        n.status === "failed"
          ? t.button({ className: "btn btn-sm", textContent: "Retry", onclick: () => retry(n.id) })
          : null,
      ),
    );
  }

  const el = page(
    "Notifications",
    t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    () => {
      if (data.loading) return loading();
      if (data.error) return errorState(data.error, load);
      if (!data.providers.length) return empty("No notification provider registered.");
      return t.div(
        {},
        whatsappCard(),
        t.div(
          { className: "table-wrap" },
          t.table(
            { className: "table" },
            t.thead(
              {},
              t.tr(
                {},
                t.th({ textContent: "Provider" }),
                t.th({ textContent: "Channels" }),
                t.th({ textContent: "State" }),
                t.th({}),
              ),
            ),
            t.tbody({}, data.providers.map(providerRow)),
          ),
        ),
        t.div(
          { className: "page-actions" },
          t.strong({ textContent: "Send log" }),
          t.select(
            {
              value: () => data.status,
              onchange: (e) => {
                data.status = e.target.value;
                loadLog(1).catch(toastError);
              },
            },
            ["", "queued", "sent", "delivered", "read", "failed"].map((s) =>
              t.option({ value: s, textContent: s || "All statuses" })
            ),
          ),
        ),
        data.log.items.length
          ? t.div(
            { className: "table-wrap" },
            t.table(
              { className: "table" },
              t.thead(
                {},
                t.tr(
                  {},
                  ["Created", "Provider", "To", "Message", "Status", "Attempts", ""].map((h) =>
                    t.th({ textContent: h })
                  ),
                ),
              ),
              t.tbody({}, data.log.items.map(logRow)),
            ),
          )
          : empty("Nothing sent yet."),
        pager(data.log, (p) => loadLog(p).catch(toastError)),
      );
    },
  );
  return onUnmount(el, () => clearInterval(timer));
}
