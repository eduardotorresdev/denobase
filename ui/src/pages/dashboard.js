// The admin home (Denobase-only; PB has no dashboard): "is anything broken or asking for action?" first, then the
// day's traffic against the day before, where the time goes, and the jobs that fail silently. Every card loads on
// its own from its own endpoint, so a slow one never holds the page; all of them read server-side rollups.

import { appTimeZone, formatDateTime, formatTime, offsetLabel, toDate, wallClock } from "../time.js";
import { humanizeCron, nextRun } from "../cron.js";
import { errorState, formatBytes, loading, onUnmount, page, pbDate } from "../ui.js";

const REFRESH_MS = 30_000;
const STATS_MS = 10_000;

const api = (path, key) => app.pb.send(path, { method: "GET", requestKey: key });

/** "812ms", "1.24s", "2m 05s": seconds from 1s up so an outlier never reads "140976.0ms". */
export function fmtMs(v) {
  if (v == null || isNaN(v)) return "–";
  if (v < 1) return `${v.toFixed(2)}ms`;
  if (v < 1000) return `${v.toFixed(v < 10 ? 1 : 0)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`;
  const s = Math.round(v / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const fmtInt = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (x) =>
  x == null || isNaN(x) ? "–" : x === 0 ? "0%" : `${(x * 100).toFixed(x < 0.1 ? 2 : 1).replace(/\.0+$/, "")}%`;
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

/** "now" / "3m" / "5h" / "2d"; the exact time (app timezone) goes in the title. */
function ago(value) {
  const d = toDate(value);
  if (!d) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "in 12m" / "in 3h" / "Tue 02:00" for a future Date. */
function until(d) {
  if (!d) return "";
  const s = (d.getTime() - Date.now()) / 1000;
  if (s < 60) return "in <1m";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return formatDateTime(d.toISOString()).slice(0, 16);
}

function fmtUptime(sec) {
  if (sec == null) return "–";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A card that loads itself: spinner on the first load only, then fn()'s element replaces the body in place on every
 * refresh (no flash, no layout jump); a failed refresh keeps the last content and marks the card stale.
 */
function liveCard(title, fn, opts = {}) {
  const body = t.div({ className: "home-card-body" }, loading());
  const note = t.span({ className: "home-card-note" });
  let loaded = false;
  const run = async () => {
    try {
      const el = await fn();
      body.replaceChildren(el);
      loaded = true;
      note.textContent = "";
      note.title = "";
    } catch (err) {
      if (err?.isAbort) return;
      if (!loaded) body.replaceChildren(errorState(err, run));
      else {
        note.textContent = "stale";
        note.title = err?.message || String(err);
      }
    }
  };
  const el = t.div(
    { className: `card home-card ${opts.className || ""}` },
    title
      ? t.div(
        { className: "home-card-head" },
        t.div({ className: "card-title", textContent: title, title: opts.tip || "" }),
        note,
        t.div({ className: "spacer" }),
        opts.href ? t.a({ className: "home-link", href: opts.href, textContent: opts.linkText || "Open" }) : null,
      )
      : null,
    body,
  );
  return { el, run };
}

/* ---------- A. needs attention ---------- */

const ICON_ERR =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2M8 10.9v.1" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const ICON_WARN =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.6M8 11.6v.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_OK =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function attention(attnP) {
  const r = await attnP;
  if (!r.items.length) {
    return t.div(
      { className: "attn-ok" },
      t.span({ className: "attn-icon ok", innerHTML: ICON_OK }),
      t.strong({ textContent: "All systems normal" }),
    );
  }
  return t.div(
    { className: "attn" },
    t.div(
      { className: "attn-head" },
      t.strong({ textContent: `${r.items.length} alert${r.items.length === 1 ? "" : "s"}` }),
    ),
    t.ul(
      { className: "attn-list" },
      ...r.items.map((i) =>
        t.li(
          null,
          (i.href ? t.a : t.div)(
            {
              className: `attn-item ${i.severity}${i.href ? "" : " static"}`,
              // The detail and when it happened go in the tooltip: a time beside one item reads like the "· 1h" window
              // of another.
              title: [i.detail, i.at ? `${formatDateTime(i.at)} (${ago(i.at)})` : ""].filter(Boolean).join("\n"),
              ...(i.href ? { href: i.href } : {}),
            },
            t.span({ className: `attn-icon ${i.severity}`, innerHTML: i.severity === "error" ? ICON_ERR : ICON_WARN }),
            t.span(
              { className: "attn-text" },
              t.span({ className: "attn-title", textContent: i.title }),
            ),
            i.href ? t.span({ className: "attn-go", textContent: "→" }) : null,
          ),
        )
      ),
    ),
  );
}

/* ---------- shared: the last 24 hours ---------- */

/** The last 24 hours as rows (empty hours included, oldest first), keyed by the server's "YYYY-MM-DD HH" hour. */
function last24h(rows, blank) {
  const byHour = new Map(rows.map((r) => [String(r.date).slice(0, 13), r]));
  const now = Date.now();
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const h = pbDate(new Date(now - i * 36e5)).slice(0, 13);
    out.push(byHour.get(h) || { date: `${h}:00:00.000Z`, ...blank });
  }
  return out;
}

/** A 24-point sparkline; nulls are gaps. */
function sparkline(values, cls = "") {
  // Fewer than two points with a value draw a flat or single-step line that says nothing: leave the space empty.
  if (values.filter((v) => v != null && v > 0).length < 2) return t.div({ className: "spark" });
  const W = 120, H = 28, P = 2;
  const nums = values.filter((v) => v != null);
  const max = Math.max(...nums, 0), min = Math.min(...nums, 0);
  const span = max - min || 1;
  const x = (i) => P + (i / Math.max(1, values.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return t.div({
    className: `spark ${cls}`,
    innerHTML: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`,
  });
}

/** "+12%" against the previous 24h (said in the tooltip), coloured by whether the change is good; empty when there is
 * nothing to compare with. */
function delta(cur, prev, { higherIsBad = false, asPoints = false } = {}) {
  const none = () => t.span({ className: "kpi-delta" });
  const same = () => t.span({ className: "kpi-delta muted", title: "vs previous 24h", textContent: "±0" });
  if (cur == null || prev == null) return none();
  let text, change;
  if (asPoints) {
    change = (cur - prev) * 100;
    if (Math.abs(change) < 0.005) return same();
    text = `${change > 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} pts`;
  } else {
    if (!prev) return none();
    change = (cur - prev) / prev;
    if (Math.abs(change) < 0.005) return same();
    text = `${change > 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
  }
  const bad = higherIsBad ? change > 0 : change < 0;
  return t.span(
    { className: `kpi-delta ${higherIsBad ? (bad ? "bad" : "good") : "neutral"}`, title: "vs previous 24h" },
    t.b({ textContent: text }),
  );
}

function kpi(label, value, sub, deltaEl, spark, opts = {}) {
  return t.a(
    { className: `card kpi home-kpi${opts.alert ? " is-alert" : ""}`, href: opts.href || "#/", title: opts.tip || "" },
    t.span({ className: "kpi-label", textContent: label }),
    t.div({ className: "kpi-value" }, value, sub ? t.span({ className: "kpi-sub", textContent: sub }) : null),
    t.div({ className: "kpi-bottom" }, deltaEl, spark),
  );
}

/* ---------- B. traffic KPIs ---------- */

// The admin UI's own requests are traced but marked; leaving them out makes the destination count what the card does.
const HTTP = "kind=1&&attributes.denobase.admin_ui=null";
const tracesHref = (filter) => `#/traces?filter=${encodeURIComponent(filter)}`;

/** Red only when the matching attention rule fired, so a card and the strip never disagree. */
function kpiRow(traffic, jobs, attn) {
  const fired = (...prefixes) => attn.items.some((i) => prefixes.some((p) => i.id.startsWith(p)));
  const c = traffic.current, p = traffic.previous;
  // The hour in progress is partial: in a sparkline it reads as a drop, so the lines end at the last full hour.
  const hours = last24h(traffic.hours, { total: 0, e4xx: 0, e5xx: 0, p50: null, p95: null }).slice(0, -1);
  const has = (x) => x.total > 0;
  const rate = has(c) ? c.e5xx / c.total : null;
  const prate = has(p) ? p.e5xx / p.total : null;
  const f = jobs.failed;
  const fhours = last24h(f.hours, { failed: 0 }).slice(0, -1);
  const perHour = c.total / 24;
  const avg = `${perHour < 1 ? "<1" : fmtInt(perHour)}/h on average`;
  return t.div(
    { className: "home-kpis" },
    kpi(
      "Requests",
      fmtInt(c.total),
      "",
      delta(c.total, has(p) ? p.total : null),
      sparkline(hours.map((h) => h.total)),
      { href: tracesHref(HTTP), tip: has(c) ? avg : "The admin's own calls are not counted" },
    ),
    kpi(
      "5xx",
      fmtPct(rate),
      "",
      delta(rate, prate, { higherIsBad: true, asPoints: true }),
      sparkline(hours.map((h) => (h.total ? h.e5xx / h.total : null)), "bad"),
      {
        href: tracesHref(`${HTTP}&&status=2`),
        alert: fired("http:5xx"),
        tip: has(c) ? `${fmtInt(c.e5xx)} 5xx · ${fmtInt(c.e4xx)} 4xx (client)` : "",
      },
    ),
    kpi(
      "p95",
      fmtMs(c.p95),
      c.p50 != null ? `p50 ${fmtMs(c.p50)}` : "",
      delta(c.p95, has(p) ? p.p95 : null, { higherIsBad: true }),
      sparkline(hours.map((h) => h.p95)),
      { href: tracesHref(HTTP), alert: fired("http:p95") },
    ),
    kpi(
      "Failed jobs",
      fmtInt(f.current),
      "",
      delta(f.current, f.previous || f.current ? f.previous : null, { higherIsBad: true }),
      sparkline(fhours.map((h) => h.failed), "bad"),
      {
        href: tracesHref('status=2&&(name~"cron "||name="mail.send")'),
        alert: attn.items.some((i) => i.severity === "error" && /^(cron:|mail:|notifications:)/.test(i.id)),
        tip: "Cron runs, emails and notifications",
      },
    ),
  );
}

/* ---------- C. requests chart ---------- */

/**
 * Count axis: a round step (1/2/5 x 10^k) and as few of them as cover the peak plus ~12% headroom, so the bars fill
 * the panel instead of half of it. Small counts step by whole requests.
 */
function countAxis(peak) {
  const top = Math.max(peak * 1.12, 1);
  const raw = top / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw));
  return { step, ticks: Math.max(1, Math.ceil(top / step)) };
}

/** Latency ticks on a log scale (1-2-5 steps) so one outlier never flattens the rest. */
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo / 1.01 && v <= hi * 1.01) out.push(v);
    }
  }
  return out.length > 4 ? out.filter((_, i) => i % Math.ceil(out.length / 4) === 0) : out;
}

/**
 * Requests per hour (ok blue, 4xx grey, 5xx red) and, under it on the same hours, p50/p95 latency on a log scale.
 * Two panels instead of a dual axis: each keeps its own scale and reads on its own.
 */
function requestsSvg(rows, W, H) {
  // The panels share whatever height the card gives them (it stretches to its row), 2/3 counts, 1/3 latency.
  const PL = 48, PR = 8, GAP = 26, PB = 20, PT = 6;
  const avail = Math.max(180, H - PT - GAP - PB);
  const H1 = Math.round(avail * 0.64), H2 = avail - H1;
  const iw = W - PL - PR, n = rows.length, bw = iw / n;
  const { step, ticks } = countAxis(Math.max(...rows.map((r) => r.total)));
  const max = step * ticks;
  const y = (v) => PT + H1 - (v / max) * H1;
  const lat = rows.flatMap((r) => (r.p95 != null ? [r.p50, r.p95] : [])).filter((v) => v > 0);
  const lo = lat.length ? Math.min(...lat) : 1, hi = lat.length ? Math.max(...lat) : 10;
  const llo = Math.log10(lo / 1.5), lhi = Math.log10(hi * 1.5);
  const top2 = PT + H1 + GAP;
  const ly = (v) => top2 + H2 - ((Math.log10(v) - llo) / (lhi - llo || 1)) * H2;
  let g =
    `<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="4" height="4" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/></pattern></defs>`;
  for (let k = 0; k <= ticks; k++) {
    const yy = y(step * k);
    g += `<line x1="${PL}" x2="${W - PR}" y1="${yy}" y2="${yy}" class="grid"/>` +
      `<text x="${PL - 6}" y="${yy + 3}" text-anchor="end">${fmtInt(step * k)}</text>`;
  }
  if (lat.length) {
    for (const v of logTicks(lo / 1.5, hi * 1.5)) {
      const yy = ly(v);
      g += `<line x1="${PL}" x2="${W - PR}" y1="${yy}" y2="${yy}" class="grid"/>` +
        `<text x="${PL - 6}" y="${yy + 3}" text-anchor="end">${esc(fmtMs(v))}</text>`;
    }
  } else {
    g += `<text x="${PL + iw / 2}" y="${top2 + H2 / 2}" text-anchor="middle">no latency yet</text>`;
  }
  g += `<text x="${PL}" y="${top2 - 10}" class="panel-label">latency</text>`;
  const every = W < 520 ? 6 : 3;
  rows.forEach((r, i) => {
    const e5 = Math.min(r.e5xx || 0, r.total), e4 = Math.min(r.e4xx || 0, r.total - e5), ok = r.total - e5 - e4;
    const x = PL + i * bw + bw * 0.16, w = bw * 0.68;
    const hh = wallClock(toDate(r.date)).hour;
    if (hh % every === 0) {
      g += `<text x="${PL + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${
        String(hh).padStart(2, "0")
      }:00</text>`;
    }
    // The last bar is the hour in progress: drawn lighter and hatched, "so far" in its tooltip, so it never reads as
    // a drop in traffic.
    const partial = i === n - 1;
    const tip =
      `${formatDateTime(r.date).slice(0, 16)}${partial ? " (so far)" : ""} · ${fmtInt(r.total)} req · ${
        fmtInt(e5)
      } 5xx · ${fmtInt(e4)} 4xx` +
      (r.p95 != null ? ` · p50 ${fmtMs(r.p50)} · p95 ${fmtMs(r.p95)}` : "");
    g += `<g><title>${esc(tip)}</title><rect x="${PL + i * bw}" y="${PT}" width="${bw}" height="${
      H1 + GAP + H2
    }" class="hit"/>`;
    let base = 0;
    for (const [v, cls] of [[e5, "e5"], [e4, "e4"], [ok, "ok"]]) {
      if (!v) continue;
      g += `<rect x="${x}" y="${y(base + v)}" width="${w}" height="${
        Math.max(1, y(base) - y(base + v))
      }" class="${cls}${partial ? " partial" : ""}"/>`;
      base += v;
    }
    g += "</g>";
  });
  for (const key of ["p50", "p95"]) {
    const pts = rows.map((r, i) => (r[key] > 0 ? [PL + i * bw + bw / 2, ly(r[key])] : null));
    let d = "", pen = false;
    for (const p of pts) {
      if (!p) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      pen = true;
    }
    if (d) g += `<path d="${d}" class="lat lat-${key}"/>`;
    for (const p of pts) if (p) g += `<circle cx="${p[0]}" cy="${p[1]}" r="2" class="lat-dot lat-${key}"/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

/** Redraws at the box's pixel size so text never stretches; the box fills the card, so the chart uses its height. */
function requestsChart(rows) {
  const box = t.div({ className: "home-chart" });
  let last = "";
  const ro = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth), h = Math.round(box.clientHeight);
    if (!box.isConnected && last) return ro.disconnect();
    if (!w || `${w}x${h}` === last) return;
    last = `${w}x${h}`;
    box.innerHTML = requestsSvg(rows, w, h);
  });
  ro.observe(box);
  return box;
}

async function requests() {
  const traffic = await api("/api/_denobase/traffic", "home-traffic");
  const rows = last24h(traffic.hours, { total: 0, e4xx: 0, e5xx: 0, p50: null, p95: null });
  if (!traffic.current.total) {
    return t.div(
      { className: "home-empty", title: "The admin's own calls are not counted" },
      t.strong({ textContent: "No requests" }),
    );
  }
  return t.div(
    { className: "home-chart-wrap" },
    t.div(
      { className: "chart-legend" },
      t.span(null, t.i({ className: "lg-ok" }), "ok"),
      t.span(null, t.i({ className: "lg-e4" }), "4xx"),
      t.span(null, t.i({ className: "lg-err" }), "5xx"),
      t.span(null, t.i({ className: "lg-line lat-p50" }), "p50"),
      t.span(null, t.i({ className: "lg-line lat-p95" }), "p95"),
    ),
    requestsChart(rows),
  );
}

/* ---------- C. slowest routes ---------- */

async function routes(tracesP) {
  const tr = await tracesP;
  if (!tr.routes.length) {
    return t.div(
      { className: "home-empty" },
      t.strong({ textContent: "Not enough traffic", title: "A route ranks once it has 20 traces" }),
    );
  }
  const top = tr.routes;
  const max = Math.max(...top.map((r) => r.p95), 1);
  return t.div(
    { className: "routes" },
    t.div({ className: "routes-head muted" }, t.span({ textContent: "p95" })),
    ...top.map((r) =>
      t.a(
        {
          className: "route",
          href: `#/traces?filter=${encodeURIComponent(`name="${r.name.replace(/"/g, '\\"')}"`)}`,
          title: `${r.name}\n${plural(r.total, "trace")} · ${fmtInt(r.errors)} failed · p50 ${fmtMs(r.p50)} · p95 ${
            fmtMs(r.p95)
          }`,
        },
        t.div(
          { className: "route-top" },
          t.span({ className: "route-name mono", textContent: r.name }),
          // Failures only when they matter (≥ 1%); the rest is in the tooltip.
          r.errors / r.total >= 0.01
            ? t.span({ className: "route-fail bad", textContent: `${fmtPct(r.errors / r.total)} failed` })
            : null,
          t.span({ className: "route-p95", textContent: fmtMs(r.p95) }),
        ),
        t.div({ className: "route-bar" }, t.i({ style: `width:${((r.p95 / max) * 100).toFixed(1)}%` })),
      )
    ),
  );
}

/* ---------- D. recent errors & slow traces ---------- */

async function problems(tracesP) {
  const tr = await tracesP;
  if (!tr.problems.length) {
    return t.div(
      { className: "home-empty" },
      t.strong({ textContent: "No issues", title: `Failed, or slow (≥ ${fmtMs(tr.slowMs)}, Settings → Traces)` }),
    );
  }
  return t.div(
    { className: "plist" },
    ...tr.problems.map((p) =>
      t.a(
        { className: "prow", href: `#/traces/${p.traceId}` },
        t.span({
          className: `dot ${p.status === 2 ? "bad" : "slow"}`,
          title: p.status === 2 ? "error" : `slow (≥ ${fmtMs(tr.slowMs)})`,
        }),
        t.span({ className: "prow-name mono", title: p.name, textContent: p.name }),
        t.span({ className: `prow-ms${p.duration >= tr.slowMs ? " slow" : ""}`, textContent: fmtMs(p.duration) }),
        t.span({ className: "prow-at", title: formatDateTime(p.created), textContent: ago(p.created) }),
      )
    ),
  );
}

/* ---------- D. jobs ---------- */

async function jobs(jobsP) {
  const j = await jobsP;
  // The app's own jobs first; denobase's maintenance (ids starting "__") only when they failed.
  const crons = j.crons.filter((c) => !c.system || c.failed24h || c.id === "__pbAutoBackup__");
  const rows = crons.slice(0, 6).map((c) => {
    const next = nextRun(c.expression);
    const human = c.id === "__pbAutoBackup__" ? "Auto backup" : c.id;
    return t.div(
      { className: "job" },
      t.span({
        className: `dot ${
          c.running ? "run" : c.last?.status === "error" ? "bad" : c.failed24h ? "warn" : c.last ? "ok" : ""
        }`,
        title: c.running
          ? "running"
          : c.last
          ? `last run ${c.last.status} · ${c.failed24h} of ${c.runs24h} runs failed in 24h`
          : "not run yet",
      }),
      t.div(
        { className: "job-main" },
        t.span({ className: "job-name", textContent: human }),
        t.span({ className: "job-when", title: c.expression, textContent: humanizeCron(c.expression) }),
      ),
      c.last
        ? t.a({
          className: `job-side${c.last.status === "error" ? " bad" : ""}`,
          href: `#/traces/${c.last.traceId}`,
          title: `${formatDateTime(c.last.at)}${next ? `\nnext ${until(next)}` : ""}`,
          textContent: `${c.last.status === "error" ? "failed" : "ok"} ${ago(c.last.at)}`,
        })
        : t.span({
          className: "job-side muted",
          title: next ? `next ${until(next)}` : "",
          textContent: "not run",
        }),
    );
  });
  const b = j.backup;
  const backupLine = !b.enabled ? null : t.a(
    { className: "job-foot", href: "#/backups" },
    t.span({ className: "muted", textContent: "Backup" }),
    b.last
      ? t.span({
        className: Date.now() - toDate(b.last.modified).getTime() > 2 * 864e5 ? "bad" : "",
        title: formatDateTime(b.last.modified),
        textContent: `${ago(b.last.modified)} · ${formatBytes(b.last.size)}`,
      })
      : t.span({ className: "bad", textContent: "none" }),
  );
  const fails = [
    ["Failed emails", j.mailFailed24h, `#/traces?filter=${encodeURIComponent('name="mail.send"&&status=2')}`],
    ...(j.notificationsFailed24h == null
      ? []
      : [["Failed notifications", j.notificationsFailed24h, "#/notifications"]]),
  ].map(([label, n, href]) =>
    t.a(
      { className: "job-foot", href },
      t.span({ className: "muted", textContent: label }),
      t.span({ className: n ? "bad" : "", textContent: fmtInt(n) }),
    )
  );
  return t.div(
    { className: "jobs" },
    rows.length
      ? t.div({ className: "job-list" }, ...rows)
      : t.div({ className: "muted home-empty-line", textContent: "No jobs", title: "No scheduled jobs of the app" }),
    t.div({ className: "job-foots" }, backupLine, ...fails),
  );
}

/* ---------- D. system ---------- */

function meterRow(label, pctFn, valueFn) {
  return t.div(
    { className: "sys-row" },
    t.div(
      { className: "sys-top" },
      t.span({ className: "muted", textContent: label }),
      t.span({ className: "sys-val", textContent: valueFn }),
    ),
    t.div(
      { className: "meter" },
      t.i({
        style: () => `width:${Math.min(100, Math.max(0, pctFn() ?? 0)).toFixed(1)}%`,
        className: () => {
          const v = pctFn() ?? 0;
          return v >= 90 ? "crit" : v >= 70 ? "high" : "";
        },
      }),
    ),
  );
}

function system(s) {
  const x = () => s.stats;
  const fb = (n) => (n == null ? "–" : formatBytes(n));
  const loadPct = () => {
    const v = x();
    return v?.loadavg?.length && v.cpus ? (v.loadavg[0] / v.cpus) * 100 : null;
  };
  const memPct = () => {
    const m = x()?.memory;
    return m?.total ? ((m.total - m.available) / m.total) * 100 : null;
  };
  return t.div(
    {
      className: "sys",
      title: () =>
        x()
          ? `CPU: 1-minute load / cores\nMemory: ${fb(x().memory?.total)} total · process ${
            fb(x().process?.rss)
          } · heap ${fb(x().process?.heapUsed)}\nDeno ${x().deno} · ${x().os}/${x().arch}${
            x().hostname ? ` · ${x().hostname}` : ""
          }`
          : "",
    },
    meterRow("CPU", loadPct, () => (x()?.loadavg?.length ? `${x().loadavg[0].toFixed(1)} / ${x().cpus}` : "–")),
    meterRow("Memory", memPct, () => (memPct() == null ? "–" : `${memPct().toFixed(0)}%`)),
    t.dl(
      { className: "sys-list" },
      t.dt({ textContent: "Uptime" }),
      t.dd({ textContent: () => fmtUptime(x()?.uptimeSec) }),
      t.dt({ textContent: "DB" }),
      t.dd({
        textContent: () => (x() ? (x().dbSizeBytes == null ? "in memory" : formatBytes(x().dbSizeBytes)) : "–"),
      }),
    ),
  );
}

/* ---------- page ---------- */

export function render(_route) {
  const s = store({ stats: null, updated: "" });
  const tz = appTimeZone();
  // One request per endpoint and refresh, shared by the cards that read it.
  let tracesP = null, attnP = null, jobsP = null;
  const traces = () => (tracesP ??= api("/api/_denobase/traces", "home-traces"));
  const attnData = () => (attnP ??= api("/api/_denobase/attention", "home-attention"));
  const jobsData = () => (jobsP ??= api("/api/_denobase/jobs", "home-jobs"));

  const attn = liveCard(null, () => attention(attnData()), { className: "home-attn" });
  const kpis = t.div({ className: "home-kpis-wrap" }, loadingKpis());
  const req = liveCard("Requests", requests, { href: tracesHref(HTTP), linkText: "Traces →" });
  const slow = liveCard("Slowest routes", () => routes(traces()), {
    href: "#/traces",
    linkText: "Traces →",
  });
  const prob = liveCard("Recent issues", () => problems(traces()), {
    href: tracesHref("status=2"),
    linkText: "Failed →",
  });
  const job = liveCard("Jobs", () => jobs(jobsData()), { href: "#/crons", linkText: "Crons →" });
  const sys = liveCard("System", () => Promise.resolve(system(s)));

  const loadKpis = async () => {
    try {
      const [traffic, j, a] = await Promise.all([
        api("/api/_denobase/traffic", "home-kpi-traffic"),
        jobsData(),
        attnData(),
      ]);
      kpis.replaceChildren(kpiRow(traffic, j, a));
    } catch (err) {
      if (!err?.isAbort && !kpis.querySelector(".home-kpis")) kpis.replaceChildren(errorState(err, loadKpis));
    }
  };
  const loadStats = async () => {
    try {
      s.stats = await api("/api/_denobase/stats", "home-stats");
    } catch { /* the System card keeps its last figures */ }
  };
  const refresh = async () => {
    tracesP = attnP = jobsP = null;
    await Promise.allSettled([attn.run(), loadKpis(), req.run(), slow.run(), prob.run(), job.run(), loadStats()]);
    s.updated = formatTime(new Date().toISOString()).slice(0, 5);
  };
  sys.run();
  refresh();

  const el = page(
    "Dashboard",
    t.div(
      { className: "home-actions" },
      t.span({
        className: "muted home-updated",
        title: `Updated at · ${tz} (${offsetLabel(tz)}), the app timezone (Settings → Application)`,
        textContent: () => `Last 24h${s.updated ? ` · ${s.updated} ${shortOffset(offsetLabel(tz))}` : ""}`,
      }),
      t.button({ className: "btn btn-sm", textContent: "Refresh", onclick: refresh }),
    ),
    t.div(
      { className: "home" },
      attn.el,
      kpis,
      t.div({ className: "home-main" }, req.el, slow.el),
      t.div({ className: "home-ops" }, prob.el, job.el, sys.el),
    ),
  );
  // A render the router discards is never mounted, so onUnmount never fires for it: the polls stop themselves once
  // the element is not in the document.
  const timers = [
    setInterval(() => (el.isConnected ? refresh() : stop()), REFRESH_MS),
    setInterval(() => (el.isConnected ? loadStats() : stop()), STATS_MS),
  ];
  const stop = () => timers.forEach(clearInterval);
  return onUnmount(el, stop);
}

function loadingKpis() {
  return t.div(
    { className: "home-kpis" },
    ...[0, 1, 2, 3].map(() => t.div({ className: "card kpi home-kpi skeleton" }, loading(""))),
  );
}

/** "UTC−03:00" → "UTC−3", "UTC+05:30" stays. */
function shortOffset(label) {
  return label.replace(/([+−-])0?(\d+):00$/, "$1$2");
}
