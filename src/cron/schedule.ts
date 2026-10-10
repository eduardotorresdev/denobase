/** PB cron schedules: 5-field expressions (and macros), matched in UTC by default or in an IANA timezone. */

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const int = (s: string) => {
  if (!/^\d+$/.test(s)) throw new Error(`invalid number ${JSON.stringify(s)}`);
  return Number(s);
};

/** PB parseCronSegment: lists, ranges, * and steps (a step only on * or a range). */
function segment(seg: string, min: number, max: number): Set<number> {
  const slots = new Set<number>();
  for (const part of seg.split(",")) {
    const steps = part.split("/");
    if (steps.length > 2) throw new Error("invalid segment step format - must be in the format */n or 1-30/n");
    const step = steps.length === 2 ? int(steps[1]) : 1;
    if (step < 1 || step > max) {
      throw new Error(`invalid segment step boundary - the step must be between 1 and the ${max}`);
    }
    let from = min, to = max;
    if (steps[0] !== "*") {
      const range = steps[0].split("-");
      if (range.length === 1) {
        if (step !== 1) {
          throw new Error("invalid segment step - step > 1 could be used only with the wildcard or range format");
        }
        from = to = int(range[0]);
      } else if (range.length === 2) {
        [from, to] = [int(range[0]), int(range[1])];
      } else throw new Error("invalid segment range format");
      if (from < min || from > max || to < min || to > max || from > to) {
        throw new Error(`invalid segment range - must be between ${min} and ${max}`);
      }
    }
    for (let i = from; i <= to; i += step) slots.add(i);
  }
  return slots;
}

export class Schedule {
  readonly minutes: Set<number>;
  readonly hours: Set<number>;
  readonly days: Set<number>;
  readonly months: Set<number>;
  readonly daysOfWeek: Set<number>;

  constructor(expr: string) {
    const segs = (MACROS[expr] ?? expr).split(" ");
    if (segs.length !== 5) {
      throw new Error("invalid cron expression - must be a valid macro or to have exactly 5 space separated segments");
    }
    this.minutes = segment(segs[0], 0, 59);
    this.hours = segment(segs[1], 0, 23);
    this.days = segment(segs[2], 1, 31);
    this.months = segment(segs[3], 1, 12);
    this.daysOfWeek = segment(segs[4], 0, 6);
  }

  /** Due when the wall clock of `d` in `timeZone` matches, so "0 2 * * *" is 02:00 there. */
  isDue(d: Date, timeZone = "UTC"): boolean {
    const w = wallClock(d, timeZone);
    return this.minutes.has(w.minute) && this.hours.has(w.hour) && this.days.has(w.day) &&
      this.daysOfWeek.has(w.weekday) && this.months.has(w.month);
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formats = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of `d` in `timeZone`; an unknown zone falls back to UTC rather than stopping every job. */
export function wallClock(d: Date, timeZone: string) {
  let f = formats.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
    } catch {
      return wallClock(d, "UTC");
    }
    formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    minute: Number(p.minute),
    hour: Number(p.hour),
    day: Number(p.day),
    month: Number(p.month),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** True when `tz` is an IANA timezone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
