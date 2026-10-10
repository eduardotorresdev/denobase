/** Cron expression helpers shared by the Crons and Backups pages. */

import { appTimeZone, offsetMinutes } from "./time.js";

const MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n) => String(n).padStart(2, "0");
const isNum = (s) => /^\d+$/.test(s);
const step = (s) => /^\*\/(\d+)$/.exec(s)?.[1];
const plural = (n, word) => Number(n) === 1 ? word : `${n} ${word}s`;

/** Joins ["a","b","c"] as "a, b and c". */
function list(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Names a field of day-of-week or month values ("1-5" -> "Monday to Friday", "1,3" -> "Monday and Wednesday"). */
function names(spec, table, offset) {
  const parts = spec.split(",").map((p) => {
    const r = /^(\d+)-(\d+)$/.exec(p);
    const name = (v) => table[(Number(v) - offset) % table.length];
    if (r) return `${name(r[1])} to ${name(r[2])}`;
    return isNum(p) ? name(p) : null;
  });
  return parts.includes(null) || parts.includes(undefined) ? null : list(parts);
}

const DATES = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** Expands a fixed list of numbers ("2", "2,14") or null. */
const nums = (s) => /^\d+(,\d+)*$/.test(s) ? s.split(",") : null;

/**
 * Describes a cron expression in plain English.
 *
 * Supports 5-field expressions (minute hour day-of-month month day-of-week) and the
 * `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly` macros, with steps (`*\/n`), lists and ranges.
 *
 * @example humanizeCron("0 2 * * *")   // "Daily at 02:00"
 * @example humanizeCron("30 9 * * 1-5") // "Weekdays at 09:30"
 * @param {string} expr cron expression
 * @returns {string} English description; "Custom: <expr>" when it cannot be described, "" when empty.
 */
export function humanizeCron(expr) {
  const raw = String(expr ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const custom = `Custom: ${raw}`;
  const parts = (MACROS[raw.toLowerCase()] || raw).split(" ");
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts;

  const days = dow === "*"
    ? ""
    : dow === "1-5"
    ? "weekdays"
    : /^(0,6|6,0)$/.test(dow)
    ? "weekends"
    : names(dow, DAYS, 0);
  const dates = dom === "*" ? "" : names(dom, DATES, 1);
  const months = mon === "*" ? "" : names(mon, MONTHS, 1);
  if (days === null || dates === null || months === null || (dates && days)) return custom;
  const inMonths = months ? ` in ${months}` : "";

  // Repeating within the day ("every ..."), then the day restrictions as suffixes.
  const every = repeating(min, hour);
  if (every) {
    const on = days ? ` on ${days}` : dates ? ` on day ${dates} of the month` : "";
    return every + on + inMonths;
  }

  // Fixed times of day.
  const mins = nums(min);
  const hours = nums(hour);
  if (!mins || !hours || mins.length * hours.length > 8) return custom;
  const at = list(hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)));
  if (dates) return months ? `Yearly on ${months} ${dates} at ${at}` : `Monthly on day ${dates} at ${at}`;
  if (days === "weekdays") return `Weekdays at ${at}${inMonths}`;
  if (days === "weekends") return `Weekends at ${at}${inMonths}`;
  if (days) return `Weekly on ${days} at ${at}${inMonths}`;
  return `Daily at ${at}${inMonths}`;
}

/** "Every ..." phrase for schedules that repeat within a day; null for fixed times. */
function repeating(min, hour) {
  if (min === "*" && hour === "*") return "Every minute";
  if (step(min) && hour === "*") return `Every ${plural(step(min), "minute")}`;
  if (!isNum(min)) return null;
  const at = min === "0" ? "" : ` at minute ${min}`;
  if (hour === "*") return `Every hour${at}`;
  const r = /^(?:(\d+)-(\d+)|\*)(?:\/(\d+))?$/.exec(hour);
  if (!r || (!r[1] && !r[3])) return null;
  const span = r[1] ? ` from ${pad(r[1])}:${pad(min)} to ${pad(r[2])}:${pad(min)}` : at;
  return `Every ${plural(r[3] || 1, "hour")}${span}`;
}

/** Splits a cron expression into its 5 fields, resolving macros; [] when it is not 5 fields. */
export function expand(expr) {
  const raw = String(expr ?? "").trim();
  const parts = (MACROS[raw.toLowerCase()] || raw).split(/\s+/);
  return parts.length === 5 ? parts : [];
}

/** Set of allowed values of one cron field ("*", "n", "a-b", "*\/n", "a-b/n", lists). null = invalid. */
export function fieldSet(spec, min, max) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = min, hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? a;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (!step || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Next run of a 5-field cron expression after `from`, matched on the wall clock of `tz` like the server's scheduler
 * (settings.meta.timezone); null if unparsable. The search runs on a Date whose UTC fields are that wall clock.
 */
export function nextRun(expr, from = new Date(), tz = appTimeZone()) {
  const raw = String(expr || "").trim();
  const parts = expand(raw);
  if (parts.length !== 5) return null;
  const [mins, hours, doms, mons, dows] = [
    fieldSet(parts[0], 0, 59),
    fieldSet(parts[1], 0, 23),
    fieldSet(parts[2], 1, 31),
    fieldSet(parts[3], 1, 12),
    fieldSet(parts[4], 0, 6),
  ];
  if (!mins || !hours || !doms || !mons || !dows) return null;
  if (parts[4].includes("7")) dows.add(0);
  const d = new Date(from.getTime() + offsetMinutes(tz, from) * 60000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!mons.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0);
      continue;
    }
    if (!doms.has(d.getUTCDate()) || !dows.has(d.getUTCDay())) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0);
      continue;
    }
    if (!hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0);
      continue;
    }
    if (!mins.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      continue;
    }
    const guess = new Date(d.getTime() - offsetMinutes(tz, d) * 60000);
    const at = new Date(d.getTime() - offsetMinutes(tz, guess) * 60000);
    if (at > from) return at;
    d.setUTCMinutes(d.getUTCMinutes() + 1); // a repeated wall-clock minute (DST end) already passed
  }
  return null;
}

/**
 * Next `count` runs of a cron expression after `from`, in the app timezone (see nextRun).
 * @param {string} expr cron expression
 * @param {number} [count]
 * @param {Date} [from]
 * @param {string} [tz] IANA timezone (defaults to the app timezone)
 * @returns {Date[]} empty when unparsable
 */
export function nextRuns(expr, count = 3, from = new Date(), tz = appTimeZone()) {
  const out = [];
  let d = from;
  while (out.length < count && (d = nextRun(expr, d, tz))) out.push(d);
  return out;
}
