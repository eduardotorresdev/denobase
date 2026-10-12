import { formatTime, toDate, wallClock } from "../time.js";
import { badge, errorState, formatBytes, formatDate, loading, onUnmount, page, pbDate, stat } from "../ui.js";
import { levelBadge, showLog } from "./logs.js";
import { tracesCard } from "./traces.js";

const STATS_EVERY_MS = 10_000;

function fmtUptime(sec) {
  if (sec == null) return "–";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const pct = (n) => (n == null || isNaN(n) ? "–" : `${n.toFixed(n < 10 ? 1 : 0)}%`);

function card(title, body, href, linkText = "Open") {
  return t.div(
    { className: "card" },
    t.div(
      { className: "row" },
      t.div({ className: "card-title", textContent: title }),
      t.div({ className: "spacer" }),
      href ? t.a({ className: "btn btn-ghost btn-xs", href, textContent: linkText }) : null,
    ),
    body,
  );
}

/** Async card: shows a spinner, then fn()'s element or an error with retry. */
function asyncCard(title, fn, href, linkText) {
  const box = t.div(null, loading());
  const run = async () => {
    box.replaceChildren(loading());
    try {
      box.replaceChildren(await fn());
    } catch (err) {
      if (!err?.isAbort) box.replaceChildren(errorState(err, run));
    }
  };
  run();
  return card(title, box, href, linkText);
}

const svg = (paths) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const KPI_ICONS = {
  uptime: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  cpu: svg(
    '<rect x="4" y="4" width="8" height="8" rx="1"/><rect x="6.5" y="6.5" width="3" height="3"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
  ),
  memory: svg(
    '<rect x="1.5" y="4.5" width="13" height="7" rx="1"/><path d="M4.5 7v2M7 7v2M9.5 7v2M12 7v2M4 11.5V13M12 11.5V13"/>',
  ),
  database: svg(
    '<ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4"/><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  ),
};

/**
 * Stat card with a fixed anatomy: header, big value, up to two label/value rows, footer strip.
 * rows: [label, () => value][]; footer: an element pinned to the bottom (meter, heatmap, stacked bar).
 */
function kpi(icon, label, value, rows, footer) {
  return t.div(
    { className: "card kpi" },
    t.div(
      { className: "kpi-head" },
      t.span({ className: "kpi-icon", innerHTML: KPI_ICONS[icon] }),
      t.span({ className: "kpi-label", textContent: label }),
    ),
    t.div({ className: "kpi-value", textContent: value }),
    t.dl(
      { className: "kpi-rows" },
      ...rows.flatMap(([k, v]) => [t.dt({ textContent: k }), t.dd({ textContent: v })]),
    ),
    t.div({ className: "kpi-foot" }, footer),
  );
}

/** Thin horizontal meter; fn() returns a 0..100 percent (or null). Dark at >=70%, red at >=90%. */
function meter(fn) {
  const fill = t.i({
    style: () => `width:${Math.min(100, Math.max(0, fn() ?? 0)).toFixed(1)}%`,
    className: () => {
      const v = fn() ?? 0;
      return v >= 90 ? "crit" : v >= 70 ? "high" : "";
    },
  });
  return t.div({ className: "meter" }, fill);
}

/** 24 hourly cells covering the last 24h (oldest left); filled = process was up in that hour. */
function uptimeHeat(fn) {
  const cells = [];
  for (let i = 0; i < 24; i++) {
    cells.push(t.i({
      className: () => {
        const up = fn();
        return up != null && (23 - i) * 3600 < up ? "on" : "";
      },
    }));
  }
  return t.div({ className: "heat", title: "Process up, last 24h by hour (oldest left)" }, ...cells);
}

const KINDS = [["base", "var(--blue)"], ["auth", "var(--black)"], ["view", "var(--g4)"]];
const kindCount = (k) => (app.store.collections || []).filter((c) => c.type === k).length;

/** Stacked bar of collection types (base/auth/view) from the sidebar's collection list. */
function collectionsBar() {
  return t.div(
    { className: "meter stacked" },
    ...KINDS.map(([k, color]) =>
      t.i({
        title: () => `${kindCount(k)} ${k}`,
        style: () => {
          const total = (app.store.collections || []).length || 1;
          return `width:${((kindCount(k) / total) * 100).toFixed(2)}%;background:${color}`;
        },
      })
    ),
  );
}

/** Four cards: host (uptime + runtime), CPU, memory (system + process), database (size + collections). */
function kpis(s) {
  const x = () => s.stats;
  const cpuPct = () => {
    const v = x();
    return v?.loadavg?.length && v.cpus ? (v.loadavg[0] / v.cpus) * 100 : null;
  };
  const memPct = () => {
    const m = x()?.memory;
    return m?.total ? ((m.total - m.available) / m.total) * 100 : null;
  };
  const fb = (n) => (n == null ? "–" : formatBytes(n));
  return t.div(
    { className: "kpi-row" },
    kpi("uptime", "Uptime", () => fmtUptime(x()?.uptimeSec), [
      ["Deno", () => x()?.deno || (s.error ? "unavailable" : "…")],
      ["Host", () => (x() ? `${x().os}/${x().arch}` : "…")],
    ], uptimeHeat(() => x()?.uptimeSec)),
    kpi("cpu", "CPU load", () => pct(cpuPct()), [
      ["Cores", () => (x()?.cpus ? String(x().cpus) : "–")],
      ["Window", () => "1m avg"],
    ], meter(cpuPct)),
    kpi(
      "memory",
      () => (x()?.memory?.total ? `Memory · ${fb(x().memory.total)}` : "System memory"),
      () => pct(memPct()),
      [
        ["Process", () => fb(x()?.process?.rss)],
        ["Heap", () => fb(x()?.process?.heapUsed)],
      ],
      meter(memPct),
    ),
    kpi(
      "database",
      "Database",
      () => (x() ? (x().dbSizeBytes == null ? "memory" : formatBytes(x().dbSizeBytes)) : "–"),
      [
        ["Collections", () => (x() ? String(x().collections) : "–")],
        ["Base/auth/view", () => KINDS.map(([k]) => kindCount(k)).join(" / ")],
      ],
      collectionsBar(),
    ),
  );
}

/** The last 24 hours as stats rows ({ date, total, errors }), empty hours included, oldest first. */
function last24h(rows) {
  const byHour = new Map(rows.map((r) => [String(r.date).slice(0, 13), r]));
  const now = Date.now();
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const h = pbDate(new Date(now - i * 36e5)).slice(0, 13);
    out.push(byHour.get(h) || { date: `${h}:00:00.000Z`, total: 0, errors: 0 });
  }
  return out;
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A round step (1/2/5 x 10^k) giving ~4 ticks with headroom above `max`. */
function niceStep(max) {
  const raw = Math.max(max * 1.15, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw);
}

const SERIES = [["avg", "lat-avg", "avg"], ["p90", "lat-p90", "p90"], ["p99", "lat-p99", "p99"]];

/**
 * 24h request chart: stacked bars per hour (ok in blue, errors in red) from /api/logs/stats, plus
 * avg/p90/p99 latency lines computed client-side from the last 24h of request logs (data.execTime).
 */
function trafficSvg(rows, lat, W, H) {
  const PL = 36, PR = 44, PT = 10, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB, n = rows.length, bw = iw / n;
  const step = niceStep(Math.max(...rows.map((r) => r.total)));
  const lvals = lat.flatMap((h) => (h ? [h.p99] : []));
  const lstep = niceStep(Math.max(...lvals, 1));
  const max = step * 4, lmax = lstep * 4;
  const y = (v) => PT + ih - (v / max) * ih;
  const ly = (v) => PT + ih - (v / lmax) * ih;
  let g = "";
  for (let k = 0; k <= 4; k++) {
    const yy = y(step * k);
    g += `<line x1="${PL}" x2="${W - PR}" y1="${yy}" y2="${yy}" class="grid"/>` +
      `<text x="${PL - 6}" y="${yy + 3}" text-anchor="end">${step * k}</text>` +
      `<text x="${W - PR + 6}" y="${yy + 3}">${+(lstep * k).toFixed(2)}ms</text>`;
  }
  const every = W < 520 ? 6 : 3;
  rows.forEach((r, i) => {
    const err = Math.min(r.errors || 0, r.total), ok = r.total - err;
    const x = PL + i * bw + bw * 0.18, w = bw * 0.64;
    const hh = wallClock(toDate(r.date)).hour;
    if (hh % every === 0) {
      g += `<text x="${PL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${
        String(hh).padStart(2, "0")
      }:00</text>`;
    }
    const l = lat[i];
    const tip = `${formatDate(r.date)} · ${r.total} req · ${err} err` +
      (l ? ` · avg ${l.avg.toFixed(1)}ms · p90 ${l.p90.toFixed(1)}ms · p99 ${l.p99.toFixed(1)}ms` : "");
    g += `<g><title>${esc(tip)}</title><rect x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" class="hit"/>`;
    if (ok) g += `<rect x="${x}" y="${y(r.total)}" width="${w}" height="${y(err) - y(r.total)}" rx="2" class="ok"/>`;
    if (err) g += `<rect x="${x}" y="${y(err)}" width="${w}" height="${PT + ih - y(err)}" rx="2" class="err"/>`;
    g += "</g>";
  });
  for (const [key, cls] of SERIES) {
    const pts = lat.map((h, i) => (h ? [PL + i * bw + bw / 2, ly(h[key])] : null)).filter(Boolean);
    if (pts.length > 1) g += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="lat ${cls}"/>`;
    for (const [cx, cy] of pts) g += `<circle cx="${cx}" cy="${cy}" r="2.5" class="lat-dot ${cls}"/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

/** Redraws at the box's pixel width so text and dots never stretch. */
function trafficChart(rows, lat) {
  const box = t.div({ className: "traffic-chart" });
  let last = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth);
    if (!box.isConnected && last) return ro.disconnect();
    if (!w || w === last) return;
    last = w;
    box.innerHTML = trafficSvg(rows, lat, w, w < 520 ? 180 : 220);
  });
  ro.observe(box);
  return box;
}

const fmtMs = (v) => (v == null ? "–" : `${v.toFixed(1)}ms`);

function traffic() {
  return asyncCard(
    "Requests",
    async () => {
      // One server pass, cached 30s: totals, errors and latency per hour (no raw rows shipped to compute them).
      const { hours, overall: all24 } = await app.pb.send("/api/_denobase/traffic", {
        method: "GET",
        requestKey: "dash-traffic",
      });
      const rows = last24h(hours);
      const lat = rows.map((r) => (r.avg == null ? null : r));
      const total = rows.reduce((a, r) => a + r.total, 0);
      const bad = rows.reduce((a, r) => a + Math.min(r.errors || 0, r.total), 0);
      const rate = total ? (bad / total) * 100 : 0;
      return t.div(
        { className: "stack" },
        t.div(
          { className: "traffic-head" },
          stat(total.toLocaleString(), "requests"),
          t.div(
            { className: `stat${bad ? " stat-err" : ""}` },
            t.span({ className: "stat-value", textContent: `${rate.toFixed(2)}%` }),
            t.span({ className: "stat-label", textContent: `error rate · ${bad} errors` }),
          ),
          stat(fmtMs(all24?.avg), "avg latency"),
          stat(fmtMs(all24?.p90), "p90"),
          stat(fmtMs(all24?.p99), "p99"),
          t.div({ className: "spacer" }),
          t.div(
            { className: "chart-legend" },
            t.span(null, t.i({ className: "lg-ok" }), "requests"),
            t.span(null, t.i({ className: "lg-err" }), "errors"),
            ...SERIES.map(([, cls, label]) => t.span(null, t.i({ className: `lg-line ${cls}` }), label)),
          ),
        ),
        trafficChart(rows, lat),
      );
    },
    "#/logs",
    "View logs →",
  );
}

function latestLogs() {
  return asyncCard("Latest logs", async () => {
    const res = await app.pb.logs.getList(1, 12, { sort: "-created", skipTotal: true, requestKey: "dash-logs" });
    if (!res.items.length) return t.div({ className: "muted", textContent: "No logs yet." });
    const th = (x, c = "") => t.th({ className: c, textContent: x });
    return t.div(
      { className: "table-wrap dash-logs" },
      t.table(
        { className: "table table-dense" },
        t.thead(
          null,
          t.tr(null, th("Level"), th("Method"), th("Path"), th("Status"), th("Duration", "num"), th("Time", "num")),
        ),
        t.tbody(
          null,
          ...res.items.map((log) => {
            const d = log.data || {};
            const path = d.url || log.message || "";
            return t.tr(
              { className: "clickable", onclick: () => showLog(log) },
              t.td(null, levelBadge(log.level)),
              t.td({ className: "mono muted", textContent: d.method || "" }),
              t.td({ className: "mono dash-path", title: path, textContent: path }),
              t.td(
                null,
                d.status
                  ? badge(String(d.status), d.status >= 500 ? "danger" : d.status >= 400 ? "warning" : "accent")
                  : null,
              ),
              t.td({
                className: "mono muted num",
                textContent: d.execTime != null ? `${Number(d.execTime).toFixed(1)}ms` : "",
              }),
              t.td({ className: "muted num", title: log.created, textContent: formatTime(log.created) }),
            );
          }),
        ),
      ),
    );
  }, "#/logs");
}

function traces() {
  return asyncCard("Traces (24h)", tracesCard, "#/traces");
}

/** Overview (Denobase-only; PB has no dashboard): host stats refreshed every 10s until the page unmounts. */
export function render(_route) {
  const s = store({ stats: null, error: null });
  const kpiRow = kpis(s);
  let timer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const loadStats = async () => {
    try {
      s.stats = await app.pb.send("/api/_denobase/stats", { method: "GET", requestKey: "dash-stats" });
      s.error = null;
    } catch (err) {
      if (!err?.isAbort) s.error = err;
    }
  };
  const grid = t.div({ className: "dash-grid" });
  const fill = () => {
    loadStats();
    grid.replaceChildren(traffic(), latestLogs(), traces());
  };
  fill();
  const el = page(
    "Dashboard",
    t.button({ className: "btn btn-sm", textContent: "Refresh", onclick: fill }),
    kpiRow,
    grid,
  );
  // A render the router discards is never mounted, so onUnmount never fires for it: the poll stops itself once the
  // element is not in the document.
  timer = setInterval(() => (el.isConnected ? loadStats() : stop()), STATS_EVERY_MS);
  return onUnmount(el, stop);
}
