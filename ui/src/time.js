// Times are stored and sent in UTC (PB); crons run and the UI displays in the app timezone (settings.meta.timezone).

const cache = new Map();
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) cache.set(key, f = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz }));
  return f;
}

/** True when `tz` is an IANA timezone this browser knows. */
export function isTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The app timezone (settings.meta.timezone), UTC until settings load or when unknown. */
export function appTimeZone() {
  const tz = globalThis.app?.store?.settings?.meta?.timezone;
  return tz && isTimeZone(tz) ? tz : "UTC";
}

/** PB date string, Date or ms -> Date (null when empty or invalid). */
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(typeof value === "string" ? value.replace(" ", "T") : value);
  return isNaN(d) ? null : d;
}

/** Wall-clock fields of `d` in `tz` (month 1-12, weekday 0 = Sunday). */
export function wallClock(d, tz = appTimeZone()) {
  const p = Object.fromEntries(
    fmt(tz, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
  };
}

/** Minutes `tz` is ahead of UTC at `d` (-180 for Sao Paulo). */
export function offsetMinutes(tz = appTimeZone(), d = new Date()) {
  const w = wallClock(d, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** "UTC−03:00" for `tz` at `d`; "UTC" at offset 0. */
export function offsetLabel(tz = appTimeZone(), d = new Date()) {
  const m = offsetMinutes(tz, d);
  if (m === 0) return "UTC";
  const a = Math.abs(m), p = (n) => String(n).padStart(2, "0");
  return `UTC${m < 0 ? "−" : "+"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

const p2 = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:MM:SS" in the app timezone; with `opts`, Intl en-GB formatting in it instead. "" when empty. */
export function formatDateTime(value, opts) {
  const d = toDate(value);
  if (!d) return value ? String(value) : "";
  const tz = appTimeZone();
  if (opts) return fmt(tz, opts).format(d);
  const w = wallClock(d, tz);
  return `${w.year}-${p2(w.month)}-${p2(w.day)} ${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`;
}

/** "YYYY-MM-DD" in the app timezone. */
export function formatDate(value) {
  return formatDateTime(value).slice(0, 10);
}

/** "HH:MM:SS" in the app timezone. */
export function formatTime(value) {
  return formatDateTime(value).slice(11);
}
