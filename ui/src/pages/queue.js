import {
  badge,
  confirm,
  empty,
  errorState,
  jsonView,
  loading,
  modal,
  onUnmount,
  page,
  pager,
  toast,
  toastError,
} from "../ui.js";
import { formatDateTime } from "../time.js";
import { alarms, timeCell, tzTip } from "../alerts.js";

const api = (path, opts = {}) => app.pb.send(`/api/queue${path}`, { method: "GET", ...opts });

const STATES = ["pending", "running", "done", "failed", "canceled"];
const QUEUES = ["normal", "heavy"];
/** Error codes that say something on their own; a handler's error is its message. */
const TELLING = new Set(["timeout", "lease_expired", "expired", "crashed", "stopped", "restored", "unknown_job"]);

export const statusKind = (s) =>
  ({ pending: "neutral", running: "info", done: "success", failed: "danger", canceled: "warning" })[s] || "neutral";

/** "4s" / "12m" / "3h" / "2d": a span of ms, short. */
export function age(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const ms = (iso) => (iso ? Date.parse(iso) : null);
const duration = (j) => (j.started && j.finished ? age(ms(j.finished) - ms(j.started)) : "—");
const pct = (fail, done) => (fail + done ? `${Math.round((fail / (fail + done)) * 100)}%` : "0%");

/** A node id `serve:host:pid:abcd1234` as "host · abcd1234"; the whole id in the tooltip. */
export function shortNode(id) {
  if (!id) return "—";
  const p = String(id).split(":");
  return p.length >= 4 ? `${p[1]} · ${p[p.length - 1].slice(0, 8)}` : id;
}

/** A number and its label, both carrying what it counts (lean UI: the number first, the meaning on hover). */
const num = (value, label, tip, kind = "") =>
  t.div(
    { className: "stat", title: tip },
    t.span({ className: `stat-value ${kind}`, title: tip, textContent: String(value) }),
    t.span({ className: "muted", title: tip, textContent: label }),
  );

/** The health's alarms, in the Dashboard's style (shared with the Crons page). */
export function healthAlarms(h) {
  const out = [];
  if (h.scheduler && h.scheduler !== "running") {
    out.push({
      severity: "error",
      title: `Scheduler ${h.scheduler}: no schedule is enqueued`,
      detail: "The scheduler service runs on no live serve. Start it on Services.",
      href: "#/services",
    });
  }
  if (h.mode === "distributed") {
    if (!h.normalConsumed) {
      out.push({
        severity: "error",
        title: "No live node consumes the normal queue",
        detail: "Jobs wait until a serve (with its worker on) or a `worker` process runs.",
      });
    }
    if (!h.heavyConsumed) {
      out.push({
        severity: "warning",
        title: "No live node consumes heavy",
        detail: "Backups and the files migration fail fast until a node runs the heavy queue.",
      });
    }
  }
  for (const n of h.noConsumer) {
    out.push({
      severity: "warning",
      title: `${n.n} pending ${n.name}: no node runs it`,
      detail: `No live node has a handler for ${n.name} (${n.queue}): it waits until one that defines it starts.`,
      href: `#/queue?status=pending&name=${encodeURIComponent(n.name)}`,
    });
  }
  for (const n of h.nodes) {
    if (n.alive && n.info?.executorError) {
      out.push({
        severity: "error",
        title: `Executors unavailable on ${shortNode(n.id)}`,
        detail: n.info.executorError,
      });
    }
  }
  return out;
}

function healthView(h, showDead) {
  const cards = QUEUES.map((q) => {
    const s = h.queues[q];
    return t.div(
      { className: "card" },
      t.div({ className: "card-title", textContent: q }),
      t.div(
        { className: "queue-nums" },
        num(s.due, "due", "Pending and due now: waiting for a free slot."),
        num(s.scheduled, "later", "Pending with a future run time: a delayed job or a retry's backoff."),
        num(s.running, "running", "Claimed by a node, under a lease it renews."),
        num(
          age(s.oldestPendingMs),
          "oldest due",
          "How long the oldest due job has waited (— when none is due).",
          s.oldestPendingMs > 60_000 ? "is-bad" : "",
        ),
        num(s.done1h, "done 1h", `Finished in the last hour (${s.done5m} in the last 5 min).`),
        num(
          pct(s.failed1h, s.done1h),
          "failed 1h",
          `${s.failed1h} failed for good in the last hour (${s.failed5m} in 5 min), as a share of what ended.`,
          s.failed1h ? "is-bad" : "",
        ),
        num(
          s.expiredLeases,
          "lapsed",
          "Running jobs whose lease lapsed: their node stopped answering; another node takes them over.",
          s.expiredLeases ? "is-bad" : "",
        ),
      ),
    );
  });
  // Live nodes only, unless asked: every deploy leaves a dead row for a day. The dead ones faded, below.
  const nodes = h.nodes.filter((n) => showDead || n.alive)
    .sort((a, b) => Number(b.alive) - Number(a.alive) || b.started - a.started);
  const table = t.div(
    { className: "table-wrap" },
    t.table(
      { className: "table table-dense" },
      t.thead(
        {},
        t.tr(
          {},
          t.th({ textContent: "Node" }),
          t.th({ textContent: "Kind" }),
          t.th({ textContent: "Queues", title: "Queues it claims from; its handlers in each row's tooltip" }),
          t.th({ textContent: "Running", title: "Jobs running there now" }),
          t.th({ textContent: "Up", title: "Since the process started" }),
          t.th({ textContent: "Beat", title: "Its last heartbeat; a node silent 15 s is dead" }),
        ),
      ),
      t.tbody(
        {},
        nodes.map((n) =>
          t.tr(
            { style: n.alive ? "" : "opacity:.5" },
            t.td({ className: "mono", title: `${n.id}\npid ${n.pid} on ${n.host}`, textContent: shortNode(n.id) }),
            t.td({}, n.kind, n.alive ? null : [" ", badge("dead", "danger")]),
            t.td({ title: n.handlers.join("\n"), textContent: n.queues.join(", ") || "—" }),
            t.td({ textContent: n.alive ? String(n.info?.running ?? 0) : "—" }),
            t.td({
              title: `${formatDateTime(new Date(n.started).toISOString())}\n${tzTip()}`,
              textContent: n.alive ? age(h.now - n.started) : "—",
            }),
            t.td({}, timeCell(new Date(n.beat).toISOString(), h.now)),
          )
        ),
      ),
    ),
  );
  return t.div(
    { className: "stack" },
    t.div({ className: "queue-grid" }, cards),
    nodes.length
      ? table
      : h.nodes.length
      ? null
      : t.p({ className: "muted", textContent: "In memory: jobs run in this process." }),
  );
}

/** The job detail: actions on top, the fields, the error, payload, attempts, trace links. */
export async function openJob(id, onchange) {
  let j;
  try {
    j = await api(`/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    return toastError(err);
  }
  const act = async (what, method = "POST") => {
    try {
      if (what === "remove") {
        if (!(await confirm(`Remove job ${j.id}?`))) return;
        await api(`/jobs/${j.id}`, { method: "DELETE" });
      } else await api(`/jobs/${j.id}/${what}`, { method });
      toast(`Job ${what === "remove" ? "removed" : what === "retry" ? "re-queued" : `${what}ed`}.`, "success");
      close();
      onchange?.();
    } catch (err) {
      toastError(err);
    }
  };
  const tip = tzTip();
  const at = (iso) => (iso ? t.span({ title: tip, textContent: formatDateTime(iso) }) : "—");
  const kv = (k, v, title) => t.tr({}, t.th({ textContent: k, title: title || "" }), t.td({}, v));
  const actions = [];
  if (j.status === "failed" || j.status === "canceled") {
    actions.push(t.button({ className: "btn btn-sm", textContent: "Retry", onclick: () => act("retry") }));
  }
  if (j.status === "pending" || j.status === "running") {
    actions.push(t.button({ className: "btn btn-sm", textContent: "Cancel", onclick: () => act("cancel") }));
  }
  if (j.status !== "running") {
    actions.push(
      t.button({ className: "btn btn-sm btn-danger", textContent: "Remove", onclick: () => act("remove") }),
    );
  }
  const code = TELLING.has(j.errorCode) ? j.errorCode : "";
  const body = t.div(
    { className: "stack" },
    t.div(
      { className: "job-head" },
      t.div(
        { className: "job-head-title" },
        badge(j.status, statusKind(j.status)),
        t.span({ className: "mono", textContent: j.name }),
      ),
      t.div({ className: "job-head-actions" }, actions),
    ),
    j.error
      ? t.div(
        { className: "alert alert-danger" },
        code ? [badge(code, "danger"), " "] : null,
        t.span({ textContent: j.error }),
      )
      : null,
    t.table(
      { className: "table table-dense kv" },
      t.tbody(
        {},
        kv("Queue", j.queue),
        kv(
          "Attempts",
          `${j.attempts} / ${j.maxAttempts}`,
          "Tries spent / allowed; a give-back (executor died) spends none",
        ),
        j.schedule
          ? kv(
            "Schedule",
            t.a({
              href: `#/queue?schedule=${encodeURIComponent(j.schedule)}`,
              className: "mono",
              textContent: j.schedule,
            }),
          )
          : null,
        kv("Created", at(j.created)),
        j.status === "pending" ? kv("Runs at", at(j.runAt)) : null,
        kv("Started", at(j.started)),
        j.status === "running"
          ? kv("Lease until", at(j.leaseUntil), "Renewed by its node's heartbeat; lapsed, another node takes it over")
          : null,
        kv("Finished", at(j.finished)),
        j.expiresAt ? kv("Expires", at(j.expiresAt), "A pending job past this fails as expired") : null,
        j.node ? kv("Node", t.span({ className: "mono", title: j.node, textContent: shortNode(j.node) })) : null,
        j.traceId
          ? kv("Trace", t.a({ href: `#/traces/${j.traceId}`, className: "mono", textContent: j.traceId }))
          : null,
        j.dedupe ? kv("Dedupe", t.span({ className: "mono", textContent: j.dedupe })) : null,
      ),
    ),
    t.div({ className: "card-title", textContent: "Payload" }),
    jsonView(j.payload),
    j.result != null ? [t.div({ className: "card-title", textContent: "Result" }), jsonView(j.result)] : null,
    j.history?.length
      ? [
        t.div(
          { className: "card-title" },
          "Attempts",
          j.historyDropped
            ? t.span({
              className: "muted",
              title: "Older attempts are not kept; only the newest 50",
              textContent: ` · ${j.historyDropped} earlier not kept`,
            })
            : null,
        ),
        t.div(
          { className: "table-wrap" },
          t.table(
            { className: "table table-dense" },
            t.tbody(
              {},
              j.history.map((a, i) =>
                t.tr(
                  {},
                  t.td({ textContent: `#${a.n || i + 1}` }),
                  t.td({}, badge(a.ok ? "ok" : TELLING.has(a.code) ? a.code : "failed", a.ok ? "success" : "danger")),
                  t.td({ title: tip, textContent: a.start ? formatDateTime(new Date(a.start).toISOString()) : "—" }),
                  t.td({ textContent: a.start && a.end ? age(a.end - a.start) : "—" }),
                  t.td({ className: "mono", title: a.node || "", textContent: shortNode(a.node) }),
                  t.td({ title: a.error || "", textContent: a.error || "" }),
                  t.td({}, a.traceId ? t.a({ href: `#/traces/${a.traceId}`, textContent: "trace" }) : null),
                )
              ),
            ),
          ),
        ),
      ]
      : null,
  );
  const { close } = modal(body, { title: `Job ${j.id}`, size: "lg" });
}

/** The columns that answer each tab's question. `status` = null: a mixed list (the crons page), with a status. */
function columns(status, now) {
  const name = { h: "Job", c: (j) => t.td({ className: "mono", title: j.id, textContent: j.name }) };
  const queue = { h: "Queue", c: (j) => t.td({ textContent: j.queue }) };
  const tries = {
    h: "Try",
    tip: "Tries spent / allowed",
    c: (j) => t.td({ textContent: `${j.attempts}/${j.maxAttempts}` }),
  };
  const time = (h, key, tip) => ({ h, tip, c: (j) => t.td({}, timeCell(j[key], now)) });
  const err = {
    h: "Error",
    c: (j) =>
      t.td(
        { className: "cell-error", title: [j.errorCode, j.error].filter(Boolean).join(": ") },
        TELLING.has(j.errorCode) ? [badge(j.errorCode, "danger"), " "] : null,
        j.error || "",
      ),
  };
  const sched = {
    h: "From",
    tip: "The schedule that enqueued it",
    c: (j) => t.td({ className: "mono muted", textContent: j.schedule || "—" }),
  };
  switch (status) {
    case "pending":
      return [
        name,
        queue,
        {
          h: "Runs",
          tip: "Due: waiting this long for a slot. In: when it becomes due (a delay or a retry's backoff)",
          c: (j) => {
            const at = ms(j.runAt);
            return t.td({
              title: `${formatDateTime(j.runAt)}\n${tzTip()}`,
              textContent: at == null ? "—" : at <= now ? `due ${age(now - at)}` : `in ${age(at - now)}`,
            });
          },
        },
        tries,
        sched,
      ];
    case "running":
      return [
        name,
        queue,
        { h: "Node", c: (j) => t.td({ className: "mono", title: j.node || "", textContent: shortNode(j.node) }) },
        time("Started", "started"),
        time("Lease until", "leaseUntil", "Renewed by the node's heartbeat; lapsed, another node takes the job"),
        tries,
      ];
    case "done":
      return [
        name,
        queue,
        time("Finished", "finished"),
        { h: "Took", c: (j) => t.td({ textContent: duration(j) }) },
        tries,
      ];
    case "failed":
      return [name, queue, err, tries, time("Finished", "finished")];
    case "canceled":
      return [name, queue, time("Canceled", "finished"), sched];
    default:
      return [
        name,
        { h: "Status", c: (j) => t.td({}, badge(j.status, statusKind(j.status))) },
        time("Created", "created"),
        { h: "Took", c: (j) => t.td({ textContent: duration(j) }) },
        err,
      ];
  }
}

/** A jobs table; `status` picks the columns of that tab (none: a mixed list with a status column). */
export function jobsTable(items, onopen, status = null) {
  const cols = columns(status, Date.now());
  return t.div(
    { className: "table-wrap" },
    t.table(
      { className: "table table-dense" },
      t.thead({}, t.tr({}, cols.map((c) => t.th({ textContent: c.h, title: c.tip || "" })))),
      t.tbody(
        {},
        items.map((j) => t.tr({ className: "clickable", onclick: () => onopen(j.id) }, cols.map((c) => c.c(j)))),
      ),
    ),
  );
}

/** The queue page: alarms, health, jobs by state (tab counts), the job detail. */
export function render(route) {
  const qv = (k) => route?.query?.[k]?.[0] || "";
  const s = store({
    health: null,
    error: null,
    status: STATES.includes(qv("status")) ? qv("status") : "pending",
    queue: "",
    name: qv("name"),
    schedule: qv("schedule"),
    counts: {},
    items: [],
    page: 1,
    perPage: 30,
    totalItems: 0,
    totalPages: 0,
    loading: true,
    dead: false,
  });

  async function load() {
    s.loading = true;
    try {
      const q = new URLSearchParams({ status: s.status, page: String(s.page), perPage: String(s.perPage) });
      if (s.queue) q.set("queue", s.queue);
      if (s.name) q.set("name", s.name);
      if (s.schedule) q.set("schedule", s.schedule);
      const [h, list] = await Promise.all([
        api("/health", { requestKey: "queue-health" }),
        api(`/jobs?${q}`, { requestKey: "queue-jobs" }),
      ]);
      s.health = h;
      Object.assign(s, {
        items: list.items,
        counts: list.counts || {},
        totalItems: list.totalItems,
        totalPages: list.totalPages,
        error: null,
      });
    } catch (err) {
      if (!err?.isAbort) s.error = err;
    } finally {
      s.loading = false;
    }
  }
  load();
  if (route?.params?.id) openJob(route.params.id, load);
  const timer = setInterval(() => !document.hidden && load(), 5_000);

  const clearFilter = () => {
    s.name = "";
    s.schedule = "";
    s.page = 1;
    location.hash = "#/queue";
    load();
  };

  const el = page(
    "Queue",
    t.div(
      { className: "home-actions" },
      t.select(
        {
          className: "input input-sm",
          title: "Queue",
          onchange: (e) => {
            s.queue = e.target.value;
            s.page = 1;
            load();
          },
        },
        t.option({ value: "", textContent: "All queues" }),
        QUEUES.map((q) => t.option({ value: q, textContent: q })),
      ),
      () => {
        const dead = s.health?.nodes.filter((n) => !n.alive).length ?? 0;
        return dead
          ? t.button({
            className: "btn btn-sm btn-ghost",
            title: "Nodes that stopped beating: their last row, kept a day",
            textContent: () => `${s.dead ? "Hide" : "Show"} ${dead} dead node${dead === 1 ? "" : "s"}`,
            onclick: () => (s.dead = !s.dead),
          })
          : null;
      },
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    ),
    () => (s.health ? alarms(healthAlarms(s.health)) : null),
    () => (s.health ? healthView(s.health, s.dead) : s.error ? errorState(s.error, load) : loading()),
    () =>
      s.name || s.schedule
        ? t.div(
          { className: "queue-filter" },
          t.span({ className: "muted", textContent: s.schedule ? "Schedule " : "Job " }),
          t.code({ textContent: s.schedule || s.name }),
          t.button({ className: "btn btn-sm btn-ghost", textContent: "× clear", onclick: clearFilter }),
        )
        : null,
    t.div(
      { className: "tabs queue-tabs" },
      STATES.map((st) =>
        t.button(
          {
            className: () => `tab${s.status === st ? " active" : ""}`,
            onclick: () => {
              s.status = st;
              s.page = 1;
              load();
            },
          },
          st,
          t.span({ className: "tab-count", textContent: () => String(s.counts[st] ?? "") }),
        )
      ),
    ),
    () => {
      if (s.loading && !s.items.length) return loading();
      if (!s.items.length) return empty(`No ${s.status} jobs.`);
      return t.div(
        { className: "stack" },
        jobsTable(s.items, (id) => openJob(id, load), s.status),
        pager(s, (p) => {
          s.page = p;
          load();
        }),
      );
    },
  );
  onUnmount(el, () => clearInterval(timer));
  return el;
}
