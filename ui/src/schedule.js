/**
 * Schedule editor: a cron expression edited through progressive human controls
 * (repeat → only the controls for that choice). Crons the controls can't express open in "Custom",
 * the only place a cron is typed. The value stays a 5-field cron for storage.
 */
import { expand, fieldSet, humanizeCron, nextRuns } from "./cron.js";
import { appTimeZone, formatDateTime, offsetLabel } from "./time.js";

export const MODES = [
  ["minutes", "Every few minutes"],
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["custom", "Custom (cron)"],
];
const MINUTE_STEPS = [5, 10, 15, 30];
// Monday first; values are cron day-of-week numbers.
const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const ON = [["all", "Every day"], ["weekdays", "Weekdays"], ["weekends", "Weekends"], ["specific", "Specific days"]];
const ON_DOW = { all: "*", weekdays: "1-5", weekends: "0,6" };

const pad = (n) => String(n).padStart(2, "0");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const isNum = (s) => /^\d+$/.test(s);

/** Cron field for a list of numbers: runs of 3+ become "a-b". */
function compact(values) {
  const v = [...new Set(values)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < v.length;) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    if (j - i >= 2) out.push(`${v[i]}-${v[j]}`);
    else for (let k = i; k <= j; k++) out.push(String(v[k]));
    i = j + 1;
  }
  return out.join(",");
}

/** True when `cron` is a valid 5-field expression (or macro). */
export function isValidCron(cron) {
  const p = expand(cron);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return p.length === 5 && p.every((f, i) => fieldSet(f, ...bounds[i]) !== null);
}

/** Default controls state. */
export function defaultState() {
  return {
    mode: "daily",
    every: 15,
    minute: 0,
    times: ["02:00"],
    on: "all",
    weekdays: [1],
    day: 1,
    custom: "",
  };
}

/** Maps a day-of-week field onto the "On" select; null when it isn't a plain list of days. */
function parseOn(dow) {
  const hit = Object.entries(ON_DOW).find(([, v]) => v === dow);
  if (hit) return { on: hit[0] };
  const set = fieldSet(dow.replace(/7/g, "0"), 0, 6);
  return set ? { on: "specific", weekdays: [...set] } : null;
}

/**
 * Maps a cron expression onto the controls; anything else opens in "custom" with the expression.
 * @param {string} cron
 * @returns {ReturnType<typeof defaultState>}
 */
export function parseCron(cron) {
  const s = defaultState();
  const raw = String(cron ?? "").trim();
  if (!raw) return s;
  const p = expand(raw);
  const custom = { ...s, mode: "custom", custom: raw };
  if (!p.length || !isValidCron(raw)) return custom;
  const [mi, ho, dm, mo, dw] = p;
  if (mo !== "*") return custom;
  const on = parseOn(dw);
  if (dm === "*" && on) {
    const every = Number(/^\*\/(\d+)$/.exec(mi)?.[1]);
    if (ho === "*" && MINUTE_STEPS.includes(every)) return { ...s, ...on, mode: "minutes", every };
    if (ho === "*" && isNum(mi)) return { ...s, ...on, mode: "hourly", minute: Number(mi) };
  }
  const mins = /^\d+(,\d+)*$/.test(mi) ? mi.split(",").map(Number) : null;
  const hours = /^\d+(,\d+)*$/.test(ho) ? ho.split(",").map(Number) : null;
  if (!mins || !hours) return custom;
  const times = hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`));
  if (dm === "*" && on && (on.on !== "specific" || times.length > 1)) return { ...s, ...on, mode: "daily", times };
  if (times.length > 1) return custom;
  if (dm === "*" && on) return { ...s, mode: "weekly", times, weekdays: on.weekdays };
  if (isNum(dm) && dw === "*") return { ...s, mode: "monthly", times, day: Number(dm) };
  return custom;
}

/** Builds the cron expression for a controls state. */
export function buildCron(s) {
  if (s.mode === "custom") return s.custom.trim();
  const days = (list) => list.length === 7 ? "*" : compact(list.length ? list : [1]);
  const dow = s.on === "specific" ? days(s.weekdays) : ON_DOW[s.on];
  if (s.mode === "minutes") return `*/${s.every} * * * ${dow}`;
  if (s.mode === "hourly") return `${s.minute} * * * ${dow}`;
  const times = s.mode === "daily" ? s.times : s.times.slice(0, 1);
  const min = compact(times.map((t) => Number(t.split(":")[1])));
  const hour = compact(times.map((t) => Number(t.split(":")[0])));
  if (s.mode === "daily") return `${min} ${hour} * * ${dow}`;
  if (s.mode === "weekly") return `${min} ${hour} * * ${days(s.weekdays)}`;
  return `${min} ${hour} ${s.day} * *`;
}

/** A run in the app timezone, labelled with its offset there ("UTC−03:00"). */
const fmtRun = (d) =>
  formatDateTime(d, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " " + offsetLabel(appTimeZone(), d);
/** Times typed here are wall-clock times in the app timezone, as the server's cron reads them. */
const tzLabel = () => offsetLabel(appTimeZone());

/**
 * Schedule field: progressive human controls over a cron expression.
 * @param {{value?: string, onChange?: (cron: string) => void, disabled?: () => boolean}} opts
 * @returns {HTMLElement}
 */
export function scheduleField({ value = "", onChange = () => {}, disabled = () => false } = {}) {
  const s = store({ ...parseCron(value), newTime: "12:00" });
  const cron = () => buildCron(s);
  const set = (patch) => {
    Object.assign(s, patch);
    onChange(cron());
  };

  const row = (...children) => t.div({ className: "sched-row" }, ...children);
  const text = (textContent) => t.span({ textContent });
  const select = (label, opts, get, put) =>
    t.select(
      {
        className: "select sched-select",
        ariaLabel: label,
        disabled,
        onchange: (e) => put(e.target.value),
        onmount: (el) => el.value = String(get()),
      },
      ...opts.map(([v, txt]) => t.option({ value: String(v), textContent: txt })),
    );
  const timeInput = (label, get, put) =>
    t.input({
      type: "time",
      className: "input sched-time",
      ariaLabel: label,
      disabled,
      value: get,
      onchange: (e) => e.target.value && put(e.target.value),
    });
  const pills = () =>
    row(...WEEKDAYS.map(([v, l]) =>
      t.button({
        type: "button",
        className: "sched-pill",
        ariaPressed: () => String(s.weekdays.includes(v)),
        disabled,
        textContent: l,
        onclick: () =>
          set({ weekdays: s.weekdays.includes(v) ? s.weekdays.filter((x) => x !== v) : [...s.weekdays, v] }),
      })
    ));
  const at = () =>
    row(text("at"), timeInput(`Time (${tzLabel()})`, () => s.times[0], (v) => set({ times: [v] })), text(tzLabel()));

  // "On" select for minutes/hourly/daily; the pills only appear for "Specific days".
  const onDays = () =>
    t.div(
      { className: "sched-step" },
      row(text("On"), select("Days", ON, () => s.on, (v) => set({ on: v }))),
      () => s.on === "specific" ? t.div({ className: "sched-step" }, pills()) : null,
    );

  /** True when the times mix hours and minutes, so cron also runs at the other pairs. */
  const mixed = () => {
    const hs = new Set(s.times.map((x) => x.split(":")[0])), ms = new Set(s.times.map((x) => x.split(":")[1]));
    return hs.size * ms.size > new Set(s.times).size;
  };

  function dailyTimes() {
    return t.div(
      { className: "sched-row" },
      text("at"),
      () =>
        s.times.map((tm, i) =>
          t.span(
            { className: "sched-chip" },
            timeInput(
              `Time ${i + 1} (${tzLabel()})`,
              () => s.times[i],
              (v) => set({ times: s.times.map((x, j) => j === i ? v : x) }),
            ),
            s.times.length > 1
              ? t.button({
                type: "button",
                className: "sched-chip-x",
                ariaLabel: `Remove ${tm}`,
                disabled,
                textContent: "×",
                onclick: () => set({ times: s.times.filter((_, j) => j !== i) }),
              })
              : null,
          )
        ),
      text(tzLabel()),
      t.button({
        type: "button",
        className: "btn btn-xs btn-ghost",
        disabled,
        textContent: "+ Add time",
        onclick: () => {
          // Same minute as the first time, so the times stay one cron (it runs every hour x minute pair).
          const [h, m] = s.times.at(-1).split(":").map(Number);
          set({ times: [...s.times, `${pad((h + 6) % 24)}:${pad(m)}`] });
        },
      }),
    );
  }

  function controls(mode) {
    if (mode === "minutes") {
      return [
        row(
          text("Every"),
          select("Minutes", MINUTE_STEPS.map((n) => [n, String(n)]), () => s.every, (v) => set({ every: Number(v) })),
          text("minutes"),
        ),
        onDays(),
      ];
    }
    if (mode === "hourly") {
      return [
        row(
          text("At minute"),
          select("Minute", range(0, 59).map((m) => [m, pad(m)]), () => s.minute, (v) => set({ minute: Number(v) })),
        ),
        onDays(),
      ];
    }
    if (mode === "daily") {
      return [
        dailyTimes(),
        () =>
          mixed()
            ? t.div({
              className: "sched-note",
              textContent: "Times with different minutes also run at every hour/minute pair.",
            })
            : null,
        onDays(),
      ];
    }
    if (mode === "weekly") return [pills(), at()];
    if (mode === "monthly") {
      return [
        row(
          text("On day"),
          select("Day of month", range(1, 31).map((d) => [d, String(d)]), () => s.day, (v) => set({ day: Number(v) })),
        ),
        at(),
      ];
    }
    return [
      t.input({
        className: () => isValidCron(s.custom) ? "input mono" : "input mono invalid",
        ariaLabel: "Cron expression",
        placeholder: "0 2 * * *",
        disabled,
        value: () => s.custom,
        oninput: (e) => set({ custom: e.target.value }),
      }),
      () =>
        isValidCron(s.custom) ? null : t.div({
          className: "field-error",
          textContent: "Enter 5 fields: minute hour day-of-month month day-of-week (e.g. 0 2 * * *).",
        }),
    ];
  }

  return t.div(
    { className: "sched" },
    row(
      text("Repeat"),
      select("Repeat", MODES, () => s.mode, (v) => {
        const patch = { mode: v };
        if (v === "custom" && !s.custom) patch.custom = cron();
        set(patch);
      }),
    ),
    () => t.div({ className: "sched-step" }, ...controls(s.mode)),
    t.div(
      { className: "sched-preview", ariaLive: "polite" },
      t.strong({ textContent: () => isValidCron(cron()) ? humanizeCron(cron()) : "Invalid schedule" }),
      t.div(
        { className: "sched-next" },
        t.span({ className: "sched-next-label", textContent: "Next runs" }),
        t.div(
          { className: "sched-next-list" },
          () => nextRuns(cron(), 3).map((d) => t.div({ textContent: fmtRun(d) })),
        ),
      ),
    ),
  );
}
