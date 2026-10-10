import {
  badge,
  copyButton,
  empty,
  errorState,
  formatDate,
  formattedDate,
  jsonView,
  loading,
  modal,
  page,
  pager,
  pbDate,
} from "../ui.js";

// PB slog levels.
export const LEVELS = [
  { value: -4, label: "DEBUG", kind: "neutral" },
  { value: 0, label: "INFO", kind: "info" },
  { value: 4, label: "WARN", kind: "warning" },
  { value: 8, label: "ERROR", kind: "danger" },
];

export const ERRORS_FILTER = "level>=8||data.status>=400";

export function levelBadge(level) {
  const l = LEVELS.find((x) => x.value === level);
  return badge(l?.label || `L${level}`, l?.kind || "neutral");
}

function statusKind(s) {
  if (!s) return "neutral";
  if (s >= 500) return "danger";
  if (s >= 400) return "warning";
  return "success";
}

/** Merges the errors-only /api/logs/stats into the full stats: rows gain `errors` (0 when none). */
export function withErrors(stats, errStats) {
  const errByDate = new Map(errStats.map((r) => [r.date, r.total]));
  return stats.map((r) => ({ ...r, errors: errByDate.get(r.date) || 0 }));
}

/**
 * Bar chart of /api/logs/stats rows ({ date, total, errors? }), one bar per hour: total in blue,
 * the error share (when `errors` is present) in black on top. `height` in px.
 */
export function statsChart(rows, height = 120) {
  const box = t.div({ className: "bars", style: `height:${height}px` });
  if (!rows.length) return box;
  const max = Math.max(...rows.map((r) => r.total), 1);
  for (const r of rows) {
    const errors = Math.min(r.errors || 0, r.total);
    const ok = r.total - errors;
    const pct = (n) => `${Math.max(n > 0 ? 1.5 : 0, (n / max) * 100).toFixed(2)}%`;
    const tip = `${formatDate(r.date)} · ${r.total} request${r.total === 1 ? "" : "s"}` +
      (r.errors != null ? ` · ${errors} error${errors === 1 ? "" : "s"}` : "");
    box.append(
      t.div(
        { className: "bar", title: tip },
        errors ? t.i({ className: "err", style: `--h:${pct(errors)}` }) : null,
        t.i({ style: `--h:${pct(ok)}` }),
      ),
    );
  }
  return box;
}

export function showLog(log) {
  const d = log.data || {};
  modal(
    t.div(
      { className: "stack" },
      t.div(
        { className: "row" },
        levelBadge(log.level),
        d.method ? badge(d.method, "accent") : null,
        d.status ? badge(String(d.status), statusKind(d.status)) : null,
        t.span({ className: "muted mono", textContent: log.id }),
        copyButton(log.id, "Copy id"),
        d.traceId
          ? t.a({ className: "btn btn-xs btn-ghost", href: `#/traces/${d.traceId}`, textContent: "View trace" })
          : null,
        t.div({ className: "spacer" }),
        formattedDate(log.created),
      ),
      t.p({ className: "mono", textContent: log.message }),
      t.dl(
        { className: "kv" },
        ...[
          ["URL", d.url],
          ["Exec time", d.execTime != null ? `${Number(d.execTime).toFixed(2)} ms` : ""],
          ["Auth", d.auth],
          ["User IP", d.userIP],
          ["Remote IP", d.remoteIP],
          ["Referer", d.referer],
          ["User agent", d.userAgent],
          ["Error", d.error],
        ].filter(([, v]) => v).flatMap(([k, v]) => [t.dt({ textContent: k }), t.dd({ textContent: String(v) })]),
      ),
      t.details({}, t.summary({ className: "muted", textContent: "Raw JSON" }), jsonView(log)),
    ),
    { title: "Log entry", size: "lg" },
  );
}

/** Request logs: filter bar with shortcuts, hourly chart (errors in black), dense table, modal detail. */
export function render(route) {
  const initial = route?.query?.filter?.[0] || "";
  const s = store({
    filter: initial,
    draft: initial,
    errorsOnly: false,
    lastHour: false,
    levels: [],
    page: 1,
    perPage: 50,
    totalItems: 0,
    totalPages: 0,
    items: [],
    stats: [],
    loading: true,
    error: null,
  });

  function fullFilter() {
    const parts = [];
    if (s.filter.trim()) parts.push(`(${s.filter.trim()})`);
    if (s.errorsOnly) parts.push(`(${ERRORS_FILTER})`);
    if (s.lastHour) parts.push(`created>="${pbDate(new Date(Date.now() - 3600_000))}"`);
    if (s.levels.length) parts.push(`(${s.levels.map((l) => `level=${l}`).join("||")})`);
    return parts.join("&&");
  }

  async function load() {
    s.loading = true;
    s.error = null;
    const filter = fullFilter();
    const errFilter = [filter, `(${ERRORS_FILTER})`].filter(Boolean).join("&&");
    try {
      const [list, stats, errStats] = await Promise.all([
        app.pb.logs.getList(s.page, s.perPage, { filter, sort: "-created", requestKey: "logs-list" }),
        app.pb.logs.getStats({ filter, requestKey: "logs-stats" }),
        app.pb.logs.getStats({ filter: errFilter, requestKey: "logs-stats-err" }).catch(() => []),
      ]);
      s.items = list.items;
      s.totalItems = list.totalItems;
      s.totalPages = list.totalPages;
      s.stats = withErrors(stats, errStats);
    } catch (err) {
      if (err?.isAbort) return;
      s.error = err;
    } finally {
      s.loading = false;
    }
  }

  function reload() {
    s.page = 1;
    load();
  }

  function toggleLevel(v) {
    const i = s.levels.indexOf(v);
    if (i >= 0) s.levels.splice(i, 1);
    else s.levels.push(v);
    reload();
  }

  const chip = (label, active, onclick, black = false) =>
    t.button({
      type: "button",
      className: () => `chip ${active() ? "active" : ""} ${black ? "chip-black" : ""}`,
      textContent: label,
      onclick,
    });

  const chartBox = t.div({ className: "card" });
  const tableBox = t.div({ className: "stack" });

  watch(() => {
    const rows = s.stats;
    const total = rows.reduce((a, r) => a + r.total, 0);
    const errors = rows.reduce((a, r) => a + (r.errors || 0), 0);
    chartBox.replaceChildren(
      t.div(
        { className: "card-head" },
        t.div({ className: "card-title", style: "margin:0", textContent: "Requests per hour" }),
        t.div(
          { className: "legend" },
          t.span({}, t.i(), `${total} requests`),
          t.span({}, t.i({ className: "err" }), `${errors} errors`),
        ),
      ),
      rows.length ? statsChart(rows) : empty("No data for this filter."),
    );
  });

  watch(() => {
    if (s.error) return tableBox.replaceChildren(errorState(s.error, load));
    if (s.loading && !s.items.length) return tableBox.replaceChildren(loading());
    if (!s.items.length) return tableBox.replaceChildren(empty("No logs match the filter."));
    tableBox.replaceChildren(
      t.div(
        { className: "table-wrap" },
        t.table(
          { className: "table table-dense" },
          t.thead(
            null,
            t.tr(
              null,
              t.th({ textContent: "Level" }),
              t.th({ textContent: "Method" }),
              t.th({ textContent: "Status" }),
              t.th({ textContent: "URL / message" }),
              t.th({ textContent: "Time" }),
              t.th({ textContent: "Created" }),
            ),
          ),
          t.tbody(
            null,
            ...s.items.map((log) => {
              const d = log.data || {};
              return t.tr(
                { className: "clickable", onclick: () => showLog(log) },
                t.td(null, levelBadge(log.level)),
                t.td({ className: "mono", textContent: d.method || "" }),
                t.td(null, d.status ? badge(String(d.status), statusKind(d.status)) : null),
                t.td({ className: "mono ellipsis", title: d.url || log.message, textContent: d.url || log.message }),
                t.td({
                  className: "muted mono",
                  textContent: d.execTime != null ? `${Number(d.execTime).toFixed(1)}ms` : "",
                }),
                t.td(null, formattedDate(log.created)),
              );
            }),
          ),
        ),
      ),
      pager(s, (p) => {
        s.page = p;
        load();
      }),
    );
  });

  load();

  return page(
    "Logs",
    t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    t.div(
      { className: "card stack" },
      t.form(
        {
          className: "searchbar",
          onsubmit: (e) => {
            e.preventDefault();
            s.filter = s.draft;
            reload();
          },
        },
        t.input({
          className: "input",
          placeholder: 'Filter, e.g. data.status>=400 && data.url~"/api/"',
          value: () => s.draft,
          oninput: (e) => (s.draft = e.target.value),
        }),
        t.button({ className: "btn btn-sm", type: "submit", textContent: "Search" }),
        t.button({
          className: "btn btn-sm btn-ghost",
          type: "button",
          textContent: "Clear",
          hidden: () => !s.filter,
          onclick: () => {
            s.draft = "";
            s.filter = "";
            reload();
          },
        }),
      ),
      t.div(
        { className: "chips" },
        chip("Errors only", () => s.errorsOnly, () => {
          s.errorsOnly = !s.errorsOnly;
          reload();
        }, true),
        chip("Last hour", () => s.lastHour, () => {
          s.lastHour = !s.lastHour;
          reload();
        }),
        t.span({ className: "muted", style: "font-size:12px;margin:0 4px", textContent: "Level" }),
        ...LEVELS.map((l) => chip(l.label, () => s.levels.includes(l.value), () => toggleLevel(l.value))),
      ),
    ),
    chartBox,
    tableBox,
  );
}
