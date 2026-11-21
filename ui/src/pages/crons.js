import { humanizeCron, nextRun } from "../cron.js";
import { badge, empty, errorState, formatDate, loading, page, toastError } from "../ui.js";
import { healthAlarms, jobsTable, openJob, statusKind } from "./queue.js";
import { alarms, timeCell, tzTip } from "../alerts.js";

const pad = (n) => String(n).padStart(2, "0");

/** "in 2h 05m" / "in 3d" relative text. */
function relative(date, now = Date.now()) {
  const s = Math.max(0, Math.round((date.getTime() - now) / 1000));
  if (s < 60) return "in less than a minute";
  const m = Math.floor(s / 60), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  if (dd >= 1) return `in ${dd}d ${pad(h % 24)}h`;
  if (h >= 1) return `in ${h}h ${pad(m % 60)}m`;
  return `in ${m}m`;
}

/** Schedules (GET /api/queue/schedules) with their last jobs; run now only enqueues. */
export function render(_route) {
  const data = store({
    jobs: [],
    health: null,
    loading: true,
    error: null,
    running: {},
    open: {},
    queued: {},
    now: Date.now(),
  });

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      const [jobs, health] = await Promise.all([
        app.pb.send("/api/queue/schedules?limit=10", { method: "GET" }),
        app.pb.send("/api/queue/health", { method: "GET", requestKey: "crons-health" }).catch(() => null),
      ]);
      data.jobs = jobs;
      data.health = health;
      data.now = Date.now();
    } catch (err) {
      if (!err?.isAbort) data.error = err;
    } finally {
      data.loading = false;
    }
  }

  async function run(id) {
    data.running[id] = true;
    try {
      // Shown in the row: the run queued now, or the one still pending/running that holds the key.
      data.queued[id] = await app.pb.send(`/api/queue/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      data.running[id] = false;
    }
  }

  load();

  function row(job) {
    const next = nextRun(job.expression, new Date(data.now));
    const last = job.jobs[0];
    return [
      t.tr(
        { rid: job.id, className: "clickable", onclick: () => (data.open[job.id] = !data.open[job.id]) },
        t.td({ className: "mono", textContent: job.id }),
        t.td(
          {},
          t.div({ title: job.expression, textContent: humanizeCron(job.expression) }),
          t.code({ className: "muted", style: "font-size:12px", title: job.expression, textContent: job.expression }),
        ),
        t.td(
          {},
          next
            ? [
              t.div({ textContent: relative(next, data.now) }),
              t.div({
                className: "muted mono",
                style: "font-size:12px",
                title: tzTip(),
                textContent: formatDate(next.toISOString()),
              }),
            ]
            : t.span({ className: "muted", textContent: "—" }),
        ),
        t.td(
          {},
          last
            ? t.a(
              {
                href: `#/queue?status=${last.status}&schedule=${encodeURIComponent(job.id)}`,
                title: "Its jobs on the Queue page",
                onclick: (e) => e.stopPropagation(),
              },
              badge(last.status, statusKind(last.status)),
              " ",
              timeCell(last.finished || last.started || last.created, data.now),
            )
            : t.span({ className: "muted", textContent: "—" }),
        ),
        t.td({
          title: `${job.runs24h} runs in the last 24h, ${job.failed24h} failed`,
          className: job.failed24h ? "text-danger" : "",
          textContent: `${job.runs24h} / ${job.failed24h}`,
        }),
        t.td(
          { className: "actions" },
          t.button({
            className: "btn btn-sm",
            title: "Queue a run now (skipped while one is pending or running)",
            disabled: () => !!data.running[job.id],
            textContent: "Run",
            onclick: (e) => {
              e.stopPropagation();
              run(job.id);
            },
          }),
          () => {
            const q = data.queued[job.id];
            return q
              ? t.a({
                className: "muted",
                style: "margin-left:8px;font-size:12px",
                href: `#/queue/${q.id}`,
                title: q.existing ? "A run was still pending or running: no new one was queued" : "The run just queued",
                onclick: (e) => e.stopPropagation(),
                textContent: q.existing ? `already ${q.status} →` : "queued →",
              })
              : null;
          },
        ),
      ),
      () =>
        data.open[job.id]
          ? t.tr(
            {},
            t.td(
              { colSpan: 6 },
              job.jobs.length ? jobsTable(job.jobs, (id) => openJob(id, load)) : empty("No runs yet."),
            ),
          )
          : null,
    ];
  }

  return page(
    "Crons",
    t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    () => {
      if (data.loading) return loading();
      if (data.error) return errorState(data.error, load);
      if (!data.jobs.length) return empty("No schedules.");
      const top = data.health ? alarms(healthAlarms(data.health).filter((a) => /^Scheduler/.test(a.title))) : null;
      return [
        top,
        t.div(
          { className: "table-wrap" },
          t.table(
            { className: "table" },
            t.thead(
              {},
              t.tr(
                {},
                t.th({ textContent: "Id" }),
                t.th({ textContent: "Expression" }),
                t.th({ textContent: "Next run", title: tzTip() }),
                t.th({ textContent: "Last" }),
                t.th({ textContent: "24h", title: "runs / failed" }),
                t.th({}),
              ),
            ),
            t.tbody({}, data.jobs.flatMap(row)),
          ),
        ),
      ];
    },
  );
}
