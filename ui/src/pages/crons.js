import { humanizeCron, nextRun } from "../cron.js";
import { empty, errorState, formatDate, loading, page, toast, toastError } from "../ui.js";

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

/** Cron jobs list (GET /api/crons) with run now (POST /api/crons/{id}). */
export function render(_route) {
  const data = store({ jobs: [], loading: true, error: null, running: {}, now: Date.now() });

  async function load() {
    data.loading = true;
    data.error = null;
    try {
      data.jobs = await app.pb.crons.getFullList();
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
      await app.pb.crons.run(id);
      toast(`Cron job "${id}" started.`, "success");
    } catch (err) {
      toastError(err);
    } finally {
      data.running[id] = false;
    }
  }

  load();

  function row(job) {
    const next = nextRun(job.expression, new Date(data.now));
    return t.tr(
      { rid: job.id },
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
            t.div({ className: "muted mono", style: "font-size:12px", textContent: formatDate(next.toISOString()) }),
          ]
          : t.span({ className: "muted", textContent: "—" }),
      ),
      t.td(
        { className: "actions" },
        t.button({
          className: "btn btn-sm",
          disabled: () => !!data.running[job.id],
          textContent: () => data.running[job.id] ? "Running..." : "Run",
          onclick: () => run(job.id),
        }),
      ),
    );
  }

  return page(
    "Crons",
    t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    t.p({
      className: "muted",
      textContent: "Jobs are registered in code and scheduled in UTC. Run executes the job in the background now.",
    }),
    () => {
      if (data.loading) return loading();
      if (data.error) return errorState(data.error, load);
      if (!data.jobs.length) return empty("No cron jobs registered.");
      return t.div(
        { className: "table-wrap" },
        t.table(
          { className: "table" },
          t.thead(
            {},
            t.tr(
              {},
              t.th({ textContent: "Id" }),
              t.th({ textContent: "Expression" }),
              t.th({ textContent: "Next run" }),
              t.th({}),
            ),
          ),
          t.tbody({}, data.jobs.map(row)),
        ),
      );
    },
  );
}
