import { badge, confirm, empty, errorState, loading, onUnmount, page, toast, toastError } from "../ui.js";
import { alarms, timeCell } from "../alerts.js";
import { age, shortNode } from "./queue.js";

const api = (path, opts = {}) => app.pb.send(`/api/services${path}`, { method: "GET", ...opts });

export const serviceKind = (s) =>
  ({
    running: "success",
    starting: "info",
    stopping: "info",
    backoff: "warning",
    standby: "neutral",
    stopped: "neutral",
    fatal: "danger",
  })[s] || "neutral";

const TIPS = {
  starting: "Started; counts as running once it stays up its start window.",
  running: "Up.",
  backoff: "Crashed; waiting before the next start (the wait doubles per crash).",
  stopping: "Stopping.",
  stopped: "Stopped; it stays down until started.",
  fatal: "Crashed too many times in a row; it stays down until started.",
  standby: "Another serve runs this singleton; this one takes over if that one goes.",
};

/** What each state lets you do: no Stop on what is down, no Restart on what never ran. */
const OPS = {
  running: ["stop", "restart"],
  starting: ["stop"],
  backoff: ["start", "stop"],
  fatal: ["start"],
  stopped: ["start"],
  standby: ["stop"],
  stopping: [],
};

/** A scheduler alarm (shared with the Crons page): no live serve runs it, so no schedule is enqueued. */
export function schedulerAlarm(items) {
  const sched = items.filter((v) => v.name === "scheduler" && v.alive !== false);
  if (!sched.length || sched.some((v) => v.state === "running")) return [];
  return [{
    severity: "error",
    title: `Scheduler ${sched[0].state}: no schedule is enqueued`,
    detail: "Every cron is silent until it runs again. Start it on Services.",
    href: "#/services",
  }];
}

/** Long services (§18): live nodes' (dead ones on demand), start/stop/restart on the serve that answers. */
export function render() {
  const s = store({ items: [], node: "", now: Date.now(), loading: true, error: null, busy: {}, dead: false });

  async function load() {
    try {
      const r = await api("", { requestKey: "services" });
      Object.assign(s, { items: r.items, node: r.node, now: r.now, error: null });
    } catch (err) {
      if (!err?.isAbort) s.error = err;
    } finally {
      s.loading = false;
    }
  }

  async function act(v, op) {
    if (v.name === "scheduler" && op === "stop") {
      const ok = await confirm("Stop the scheduler? No cron is enqueued until it starts again.");
      if (!ok) return;
    }
    s.busy[v.name] = true;
    try {
      await api(`/${encodeURIComponent(v.name)}/${op}`, { method: "POST" });
      toast(`${v.name}: ${op}`, "success");
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      s.busy[v.name] = false;
    }
  }

  load();
  const timer = setInterval(() => !document.hidden && load(), 3_000);

  function row(v) {
    const reason = v.lastExitReason || "";
    const crash = v.lastExitAt
      ? t.span({ title: reason }, timeCell(new Date(v.lastExitAt).toISOString(), s.now), reason ? ` · ${reason}` : "")
      : t.span({ className: "muted", textContent: "—" });
    // The buttons act on the serve answering this page: other nodes' rows are read-only here.
    const mine = v.node === s.node;
    const stateTip = [TIPS[v.state], v.state === "fatal" || v.state === "backoff" ? reason : ""].filter(Boolean).join(
      "\n",
    );
    return t.tr(
      { style: v.alive === false ? "opacity:.5" : "" },
      t.td({ className: "mono", textContent: v.name }),
      t.td({ className: "mono muted", title: v.node, textContent: shortNode(v.node) }),
      t.td(
        { title: stateTip },
        badge(v.alive === false ? "dead node" : v.state, v.alive === false ? "danger" : serviceKind(v.state)),
        v.singleton
          ? t.span({
            className: "svc-tag",
            title: "Singleton: one serve in the cluster runs it; the others stand by",
            textContent: "singleton",
          })
          : null,
      ),
      t.td({ textContent: v.state === "running" && v.startedAt ? age(s.now - v.startedAt) : "—" }),
      t.td({ title: "Crashes in a row (reset by a run that stayed up)", textContent: String(v.retries) }),
      t.td({ className: "cell-error" }, crash),
      t.td({
        title: `${v.calls ?? 0} calls · ${v.errors ?? 0} errors · ${v.avgMs ?? 0} ms mean`,
        textContent: `${v.calls ?? 0} / ${v.errors ?? 0}`,
      }),
      t.td(
        {},
        mine && v.alive !== false
          ? t.div(
            { className: "svc-actions" },
            (OPS[v.state] || []).map((op) =>
              t.button({
                className: "btn btn-sm btn-ghost",
                textContent: op[0].toUpperCase() + op.slice(1),
                disabled: () => !!s.busy[v.name],
                onclick: () => act(v, op),
              })
            ),
          )
          : null,
      ),
    );
  }

  const el = page(
    "Services",
    t.div(
      { className: "home-actions" },
      () => {
        const dead = new Set(s.items.filter((v) => v.alive === false).map((v) => v.node)).size;
        return dead
          ? t.button({
            className: "btn btn-sm btn-ghost",
            title: "Nodes that stopped beating: their last state, kept a day",
            textContent: () => `${s.dead ? "Hide" : "Show"} ${dead} dead node${dead === 1 ? "" : "s"}`,
            onclick: () => (s.dead = !s.dead),
          })
          : null;
      },
      t.button({ className: "btn btn-sm btn-ghost", textContent: "Refresh", onclick: load }),
    ),
    () => {
      if (s.loading) return loading();
      if (s.error) return errorState(s.error, load);
      const items = s.items.filter((v) => s.dead || v.alive !== false);
      if (!items.length) return empty("No long services.");
      return t.div(
        { className: "stack" },
        alarms([
          ...schedulerAlarm(s.items),
          ...[...new Set(s.items.filter((v) => v.alive !== false && v.socketOutside).map((v) => v.node))].map((n) => ({
            severity: "warning",
            title: `Socket of ${shortNode(n)} is outside pb_data`,
            detail: "pb_data's path is too long for a socket address, so it listens in the system temp dir: " +
              "workers in another container or host sharing pb_data cannot call its services. Use a shorter pb_data path.",
          })),
        ]),
        t.div(
          { className: "table-wrap" },
          t.table(
            { className: "table table-dense svc-table" },
            t.thead(
              {},
              t.tr(
                {},
                t.th({ textContent: "Service" }),
                t.th({ textContent: "Node" }),
                t.th({ textContent: "State" }),
                t.th({ textContent: "Up" }),
                t.th({ textContent: "Crashes", title: "Crashes in a row" }),
                t.th({ textContent: "Last crash", title: "When and why it last went down" }),
                t.th({ textContent: "Calls / errors", title: "Calls served on that node since it started" }),
                t.th({}),
              ),
            ),
            t.tbody({}, items.map(row)),
          ),
        ),
      );
    },
  );
  onUnmount(el, () => clearInterval(timer));
  return el;
}
