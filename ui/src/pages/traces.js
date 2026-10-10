// Traces: real spans from /api/traces (denobase telemetry, _spans in the aux db). List page in the logs.js
// pattern, detail page (#/traces/{id}) with the span waterfall, and the dashboard card.

import {
  badge,
  confirm,
  copyButton,
  empty,
  errorState,
  formatDate,
  formattedDate,
  jsonView,
  loading,
  page,
  pager,
  pbDate,
  stat,
  toast,
} from "../ui.js";
import { showLog, statsChart } from "./logs.js";

export const KINDS = ["internal", "server", "client", "producer", "consumer"];
const STATUS = [
  { value: 0, label: "UNSET", kind: "neutral" },
  { value: 1, label: "OK", kind: "success" },
  { value: 2, label: "ERROR", kind: "danger" },
];
const TRACE_ID = /^[0-9a-f]{32}$/i;
const PERIODS = [
  { label: "Last hour", ms: 3600_000 },
  { label: "24h", ms: 864e5 },
  { label: "7d", ms: 7 * 864e5 },
];

const api = (path, opts = {}) => app.pb.send(path, { method: "GET", ...opts });
const slowMs = () => app.store.settings?.traces?.slowMs || 1000;
const ms = (n) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Number(n).toFixed(n < 10 ? 2 : 1)}ms`);
/** Span start is epoch µs; the API also gives `created` (PB date), used for display. */
const startDate = (us) => pbDate(new Date(Math.floor(us / 1000)));

export function statusBadge(status) {
  const s = STATUS.find((x) => x.value === status) || STATUS[0];
  return badge(s.label, s.kind);
}

function httpStatus(attrs) {
  const code = attrs?.["http.response.status_code"];
  if (!code) return null;
  return badge(String(code), code >= 500 ? "danger" : code >= 400 ? "warning" : "success");
}

/** Hourly stats rows -> the bar chart rows logs.js draws ({ date, total, errors }). */
function chartRows(stats) {
  return stats.map((r) => ({ date: r.date, total: r.total, errors: r.errors }));
}

/** Root filters: the chips speak of the trace (its root), not of any span inside it. */
const ERRORS = "(root=1&&status=2)";
const slowFilter = () => `(root=1&&duration>=${slowMs()})`;

function tracesTable(items, onOpen) {
  const max = Math.max(...items.map((x) => x.duration), 1);
  return t.div(
    { className: "table-wrap" },
    t.table(
      { className: "table table-dense" },
      t.thead(
        null,
        t.tr(
          null,
          t.th({ textContent: "Status" }),
          t.th({ textContent: "Name" }),
          t.th({ textContent: "HTTP" }),
          t.th({ textContent: "Duration", style: "width:180px" }),
          t.th({ textContent: "Spans" }),
          t.th({ textContent: "Trace id" }),
          t.th({ textContent: "Started" }),
        ),
      ),
      t.tbody(
        null,
        ...items.map((tr) =>
          t.tr(
            { className: "clickable", onclick: () => onOpen(tr) },
            t.td(null, statusBadge(tr.status)),
            t.td({ className: "mono ellipsis", title: tr.name, textContent: tr.name }),
            t.td(null, httpStatus(tr.attributes)),
            t.td(
              null,
              t.div(
                { className: "row", style: "flex-wrap:nowrap;gap:6px" },
                t.div(
                  { className: "trace-bar-track", style: "flex:1;margin:0" },
                  t.i({
                    className: `trace-bar ${tr.status === 2 ? "root" : ""}`,
                    style: `left:0;width:${Math.max(1, (tr.duration / max) * 100).toFixed(2)}%`,
                  }),
                ),
                t.span({
                  className: "mono muted",
                  style: "min-width:58px;text-align:right",
                  textContent: ms(tr.duration),
                }),
              ),
            ),
            t.td(
              { className: "mono muted" },
              `${tr.spanCount}`,
              tr.errorCount
                ? t.span({ style: "color:var(--danger, #c00)", textContent: ` · ${tr.errorCount} err` })
                : null,
            ),
            t.td({ className: "mono muted", textContent: tr.traceId.slice(0, 12) }),
            t.td(null, formattedDate(tr.created || startDate(tr.start))),
          )
        ),
      ),
    ),
  );
}

/** Trace list: filter bar + chips, hourly chart (errors in black) with percentiles, dense table. */
function listPage(route) {
  const initial = route?.query?.filter?.[0] || "";
  const s = store({
    filter: initial,
    draft: initial,
    errorsOnly: false,
    slowOnly: false,
    kind: "",
    period: 1,
    page: 1,
    perPage: 50,
    totalItems: 0,
    totalPages: 0,
    items: [],
    stats: [],
    sum: { total: 0, errors: 0, p50: 0, p95: 0, p99: 0 },
    loading: true,
    error: null,
  });

  function fullFilter() {
    const parts = [];
    if (s.filter.trim()) parts.push(`(${s.filter.trim()})`);
    if (s.errorsOnly) parts.push(ERRORS);
    if (s.slowOnly) parts.push(slowFilter());
    if (s.kind === "http") parts.push("kind=1");
    if (s.kind === "cron") parts.push('name~"cron "');
    if (s.kind === "worker") parts.push('name~"worker "');
    const p = PERIODS[s.period];
    if (p) parts.push(`created>="${pbDate(new Date(Date.now() - p.ms))}"`);
    return parts.join("&&");
  }

  async function load() {
    s.loading = true;
    s.error = null;
    const filter = fullFilter();
    try {
      const q = (o) => new URLSearchParams(o).toString();
      const [list, stats, sum] = await Promise.all([
        api(`/api/traces?${q({ filter, sort: "-start", page: s.page, perPage: s.perPage })}`, {
          requestKey: "traces-list",
        }),
        api(`/api/traces/stats?${q({ filter })}`, { requestKey: "traces-stats" }),
        api(`/api/traces/stats?${q({ filter, groupBy: "total" })}`, { requestKey: "traces-total" }),
      ]);
      s.sum = sum;
      s.items = list.items;
      s.totalItems = list.totalItems;
      s.totalPages = list.totalPages;
      s.stats = stats;
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

  function search(e) {
    e.preventDefault();
    const v = s.draft.trim();
    if (TRACE_ID.test(v)) {
      globalThis.location.hash = `#/traces/${v.toLowerCase()}`;
      return;
    }
    s.filter = v;
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
    const sum = s.sum;
    chartBox.replaceChildren(
      t.div(
        { className: "card-head" },
        t.div({ className: "card-title", style: "margin:0", textContent: "Traces per hour" }),
        t.div(
          { className: "legend" },
          t.span({}, t.i(), `${sum.total} traces`),
          t.span({}, t.i({ className: "err" }), `${sum.errors} errors`),
          sum.total
            ? t.span({
              className: "mono muted",
              textContent: `p50 ${ms(sum.p50)} · p95 ${ms(sum.p95)} · p99 ${ms(sum.p99)}`,
            })
            : null,
        ),
      ),
      s.stats.length ? statsChart(chartRows(s.stats)) : empty("No traces for this filter."),
    );
  });

  watch(() => {
    if (s.error) return tableBox.replaceChildren(errorState(s.error, load));
    if (s.loading && !s.items.length) return tableBox.replaceChildren(loading());
    if (!s.items.length) return tableBox.replaceChildren(empty("No traces match the filter."));
    tableBox.replaceChildren(
      tracesTable(s.items, (tr) => (globalThis.location.hash = `#/traces/${tr.traceId}`)),
      pager(s, (p) => {
        s.page = p;
        load();
      }),
    );
  });

  load();

  async function clearAll() {
    if (!(await confirm("Delete every stored trace?", { danger: true, yes: "Delete all" }))) return;
    try {
      await api("/api/traces", { method: "DELETE" });
      toast("Traces deleted.", "success");
      reload();
    } catch (err) {
      toast(err?.message || "Delete failed.", "error");
    }
  }

  return page(
    "Traces",
    t.div(
      { className: "row" },
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Delete all", onclick: clearAll }),
    ),
    t.div(
      { className: "card stack" },
      t.form(
        { className: "searchbar", onsubmit: search },
        t.input({
          className: "input",
          placeholder: 'Trace id, or filter e.g. name~"/api/collections" && duration>100',
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
        chip(() => `Slow (≥${slowMs()}ms)`, () => s.slowOnly, () => {
          s.slowOnly = !s.slowOnly;
          reload();
        }),
        t.span({ className: "muted", style: "font-size:12px;margin:0 4px", textContent: "Type" }),
        ...[["http", "HTTP"], ["cron", "Cron"], ["worker", "Jobs"]].map(([k, label]) =>
          chip(label, () => s.kind === k, () => {
            s.kind = s.kind === k ? "" : k;
            reload();
          })
        ),
        t.span({ className: "muted", style: "font-size:12px;margin:0 4px", textContent: "Period" }),
        ...PERIODS.map((p, i) =>
          chip(p.label, () => s.period === i, () => {
            s.period = s.period === i ? -1 : i;
            reload();
          })
        ),
      ),
    ),
    chartBox,
    tableBox,
  );
}

function attrsTable(attrs) {
  const rows = Object.entries(attrs || {});
  if (!rows.length) return t.div({ className: "muted", textContent: "No attributes." });
  return t.div(
    { className: "trace-attrs" },
    ...rows.map(([k, v]) =>
      t.div(
        { className: "trace-attr" },
        t.span({ className: "mono muted", textContent: k }),
        t.span({
          className: "mono",
          title: typeof v === "string" ? v : JSON.stringify(v),
          textContent: typeof v === "string" ? v : JSON.stringify(v),
        }),
      )
    ),
  );
}

function spanDetail(span) {
  return t.div(
    { className: "stack", style: "gap:8px" },
    t.div(
      { className: "row" },
      statusBadge(span.status),
      badge(KINDS[span.kind] || `kind ${span.kind}`, "accent"),
      t.span({ className: "mono", textContent: span.name }),
      t.span({ className: "muted mono", textContent: span.id }),
      copyButton(span.id, "Copy span id"),
    ),
    attrsTable(span.attributes),
    span.events?.length
      ? t.details(
        { open: true },
        t.summary({ className: "muted", textContent: `Events (${span.events.length})` }),
        jsonView(span.events),
      )
      : null,
  );
}

/** Waterfall: one row per span, indented by depth, bar placed by offset from the root start. */
function waterfall(root, onSelect) {
  const t0 = root.start;
  let end = root.start + root.duration * 1000;
  const flat = [];
  const walk = (n, depth) => {
    flat.push([n, depth]);
    end = Math.max(end, n.start + n.duration * 1000);
    for (const c of [...n.children].sort((a, b) => a.start - b.start)) walk(c, depth + 1);
  };
  walk(root, 0);
  const total = Math.max((end - t0) / 1000, 0.001);
  return t.div(
    { className: "traces" },
    t.div(
      { className: "trace-spans", style: "border-top:0;background:transparent" },
      t.div(
        { className: "trace-span-head trace-span-cols" },
        t.span({ textContent: "Span" }),
        t.span({ textContent: "Tipo" }),
        t.span({ className: "num", textContent: "Início", title: "Quando o span começou, contado do início do trace" }),
        t.span({ className: "num", textContent: "Duração", title: "Quanto tempo o span levou" }),
      ),
      ...flat.map(([n, depth]) => {
        const off = (n.start - t0) / 1000;
        const color = n.status === 2
          ? "var(--danger, #d33)"
          : n.kind === 2
          ? "var(--g4, #888)"
          : depth
          ? "var(--blue)"
          : "var(--black)";
        return t.div(
          { className: "trace-span", style: `--depth:${depth}`, onclick: () => onSelect(n) },
          t.div(
            { className: "trace-span-head trace-span-cols" },
            t.span(
              { className: "mono trace-span-name" },
              n.status === 2 ? t.strong({ textContent: "! " }) : null,
              n.name,
            ),
            t.span({ className: "muted", textContent: KINDS[n.kind] || String(n.kind) }),
            t.span({ className: "muted mono num", textContent: `+${ms(off)}` }),
            t.span({ className: "mono num", textContent: ms(n.duration) }),
          ),
          t.div(
            { className: "trace-bar-track" },
            t.i({
              className: "trace-bar",
              style: `background:${color};left:${((off / total) * 100).toFixed(3)}%;width:${
                Math.max(0.4, (n.duration / total) * 100).toFixed(3)
              }%`,
            }),
          ),
        );
      }),
    ),
  );
}

/** One trace: header, waterfall, the selected span's attributes and events, and its logs. */
async function detailPage(id) {
  let tr;
  try {
    tr = await api(`/api/traces/${encodeURIComponent(id)}`, { requestKey: "trace-view" });
  } catch (err) {
    return page(
      "Trace",
      t.a({ className: "btn btn-sm btn-ghost", href: "#/traces", textContent: "Back" }),
      err?.status === 404 ? empty(`Trace ${id} not found (not sampled, or already cleaned up).`) : errorState(err),
    );
  }
  const root = tr.root;
  const sel = store({ span: root });
  const detailBox = t.div({ className: "card" });
  watch(() => detailBox.replaceChildren(spanDetail(sel.span)));
  const logsHref = `#/logs?filter=${encodeURIComponent(`data.traceId='${tr.traceId}'`)}`;
  return page(
    "Trace",
    t.div(
      { className: "row" },
      t.a({ className: "btn btn-sm btn-ghost", href: "#/traces", textContent: "Back" }),
      // Only request traces write activity logs (crons, workers and the logs API itself do not): 0 says so.
      tr.logs?.length
        ? t.a({ className: "btn btn-sm", href: logsHref, textContent: `View logs (${tr.logs.length})` })
        : t.button({ className: "btn btn-sm", disabled: true, title: "No logs in this trace", textContent: "No logs" }),
    ),
    t.div(
      { className: "card stack" },
      t.div(
        { className: "row" },
        statusBadge(root.status),
        httpStatus(root.attributes),
        t.strong({ className: "mono", textContent: root.name }),
        t.div({ className: "spacer" }),
        formattedDate(root.created || startDate(root.start)),
      ),
      t.div(
        { className: "row" },
        t.span({ className: "muted", textContent: "Trace" }),
        t.span({ className: "mono", textContent: tr.traceId }),
        copyButton(tr.traceId, "Copy trace id"),
        t.div({ className: "spacer" }),
        t.span({
          className: "mono muted",
          textContent: `${ms(root.duration)} · ${tr.spans} spans · ${tr.logs?.length || 0} logs`,
        }),
      ),
    ),
    t.div({ className: "card" }, waterfall(root, (n) => (sel.span = n))),
    detailBox,
    tr.logs?.length
      ? t.div(
        { className: "card" },
        t.div({ className: "card-title", textContent: "Logs in this trace" }),
        ...tr.logs.map((l) =>
          t.div(
            { className: "log-line clickable", onclick: () => showLog(l) },
            t.span({ className: "mono muted", textContent: formatDate(l.created).slice(11) }),
            t.span({ className: "mono log-url", textContent: l.data?.url || l.message }),
            l.data?.status ? badge(String(l.data.status), l.data.status >= 400 ? "warning" : "success") : null,
          )
        ),
      )
      : null,
  );
}

export function render(route) {
  const id = route?.params?.id;
  return id ? detailPage(id) : listPage(route);
}

/** Dashboard card body: 24h KPIs from /api/traces/stats, hourly bars, latest slow/error traces. */
export async function tracesCard() {
  const since = `created>="${pbDate(new Date(Date.now() - 864e5))}"`;
  const q = (o) => new URLSearchParams(o).toString();
  const [stats, sum, bad] = await Promise.all([
    api(`/api/traces/stats?${q({ filter: since })}`, { requestKey: "dash-traces-stats" }),
    api(`/api/traces/stats?${q({ filter: since, groupBy: "total" })}`, { requestKey: "dash-traces-total" }),
    api(`/api/traces?${q({ filter: `${since}&&(${ERRORS}||${slowFilter()})`, sort: "-start", perPage: 5 })}`, {
      requestKey: "dash-traces-bad",
    }),
  ]);
  return t.div(
    { className: "stack" },
    stat(
      sum.total ? `p95 ${ms(sum.p95)}` : "–",
      `${sum.total} traces · ${sum.errors} errors`,
      sum.total ? `p50 ${ms(sum.p50)} · p99 ${ms(sum.p99)}` : "",
    ),
    statsChart(chartRows(stats), 64),
    bad.items.length
      ? t.div(
        null,
        t.div({ className: "muted", style: "font-size:12px", textContent: "Latest slow / error traces" }),
        ...bad.items.map((tr) =>
          t.a(
            { className: "log-line", href: `#/traces/${tr.traceId}`, style: "color:inherit;text-decoration:none" },
            statusBadge(tr.status),
            t.span({ className: "mono log-url", title: tr.name, textContent: tr.name }),
            t.span({ className: "mono muted", textContent: ms(tr.duration) }),
          )
        ),
      )
      : t.div({ className: "muted", textContent: "No slow or failed traces in 24h." }),
  );
}
