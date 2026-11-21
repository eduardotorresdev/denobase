import type { DatabaseSync } from "node:sqlite";
import { stamp } from "../core/time.ts";
import { histIndex, histQuantile } from "./histogram.ts";

/**
 * Request traffic per hour for the admin home, counted by the HTTP middleware itself: the activity log can be off or
 * skip successes (logs.minLevel) and traces are sampled, so neither gives the real count. One row per hour in the
 * auxiliary db with totals, 4xx, 5xx, failed sign-ins and a log-scale latency histogram; counts accumulate in memory
 * and are written at most every FLUSH_MS (and before every read), so a request costs a few map updates. A second,
 * per-minute table (no histogram, two hours kept) answers the sliding "last 60 minutes" rules: a burst at 15:58 must
 * still show at 16:01, which an hour bucket would have reset.
 */
export class RequestStats {
  #pending = new Map<string, Hour>();
  #minutes = new Map<string, Hour>();
  #last = 0;

  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS _requests_hourly (hour TEXT PRIMARY KEY NOT NULL, total INTEGER NOT NULL,
      e4xx INTEGER NOT NULL, e5xx INTEGER NOT NULL, "authFailed" INTEGER NOT NULL, hist TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS _requests_minutely (minute TEXT PRIMARY KEY NOT NULL, total INTEGER NOT NULL,
      e5xx INTEGER NOT NULL, "authFailed" INTEGER NOT NULL) WITHOUT ROWID`);
  }

  /** One finished request; `authFailed` is a rejected password/OTP sign-in. */
  record(status: number, ms: number, authFailed: boolean = false, at: Date = new Date()): void {
    const at16 = stamp(at).slice(0, 16);
    for (const [map, key] of [[this.#pending, at16.slice(0, 13)], [this.#minutes, at16]] as const) {
      let h = map.get(key);
      if (!h) map.set(key, h = emptyHour());
      h.total++;
      if (status >= 500) h.e5xx++;
      else if (status >= 400) h.e4xx++;
      if (authFailed) h.authFailed++;
      if (map === this.#pending) {
        const k = histIndex(ms);
        h.hist.set(k, (h.hist.get(k) ?? 0) + 1);
      }
    }
    if (performance.now() - this.#last > FLUSH_MS) this.flush();
  }

  /** Writes the pending counts onto the stored hours. */
  flush(): void {
    this.#last = performance.now();
    if (!this.#pending.size && !this.#minutes.size) return;
    const pending = this.#pending, minutes = this.#minutes;
    this.#pending = new Map();
    this.#minutes = new Map();
    const get = this.db.prepare(`SELECT total, e4xx, e5xx, "authFailed", hist FROM _requests_hourly WHERE hour = ?`);
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO _requests_hourly (hour, total, e4xx, e5xx, "authFailed", hist) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      for (const [hour, h] of pending) {
        const old = get.get(hour) as Record<string, unknown> | undefined;
        if (old) merge(h, old);
        put.run(hour, h.total, h.e4xx, h.e5xx, h.authFailed, JSON.stringify(Object.fromEntries(h.hist)));
      }
      const addMinute = this.db.prepare(
        `INSERT INTO _requests_minutely (minute, total, e5xx, "authFailed") VALUES (?, ?, ?, ?)
         ON CONFLICT (minute) DO UPDATE SET total = total + excluded.total, e5xx = e5xx + excluded.e5xx,
         "authFailed" = "authFailed" + excluded."authFailed"`,
      );
      let newest = "";
      for (const [minute, h] of minutes) {
        addMinute.run(minute, h.total, h.e5xx, h.authFailed);
        if (minute > newest) newest = minute;
      }
      // Two hours behind the newest minute written: enough for a sliding hour, and the table stays tiny.
      if (newest) {
        const cut = stamp(new Date(new Date(`${newest.replace(" ", "T")}:00Z`).getTime() - 2 * 36e5)).slice(0, 16);
        this.db.prepare(`DELETE FROM _requests_minutely WHERE minute < ?`).run(cut);
      }
      if (own) this.db.exec("COMMIT");
    } catch (e) {
      if (own) this.db.exec("ROLLBACK");
      // Counts are best effort: losing one flush must never fail the request that triggered it.
      console.error("request stats flush failed", e);
    }
  }

  /** The last `hours` hours (current) and the ones before them (previous), plus the current ones per hour. */
  overview(now: Date = new Date(), hours: number = 24): RequestOverview {
    this.flush();
    const hourOf = (d: Date) => stamp(d).slice(0, 13);
    const mid = hourOf(new Date(now.getTime() - (hours - 1) * 36e5));
    const from = hourOf(new Date(now.getTime() - (2 * hours - 1) * 36e5));
    const rows = this.db.prepare(`SELECT * FROM _requests_hourly WHERE hour >= ? ORDER BY hour`).all(from) as Record<
      string,
      unknown
    >[];
    const cur = emptyHour(), prev = emptyHour(), out: RequestHour[] = [];
    for (const r of rows) {
      const h = emptyHour();
      merge(h, r);
      if (String(r.hour) < mid) {
        merge(prev, r);
        continue;
      }
      merge(cur, r);
      out.push({ date: `${r.hour}:00:00.000Z`, ...figures(h) });
    }
    const lastHour = this.db.prepare(
      `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(e5xx), 0) AS e5xx,
         COALESCE(SUM("authFailed"), 0) AS "authFailed" FROM _requests_minutely WHERE minute > ?`,
    ).get(stamp(new Date(now.getTime() - 36e5)).slice(0, 16)) as Record<string, number>;
    return {
      current: figures(cur),
      previous: figures(prev),
      hours: out,
      lastHour: { total: Number(lastHour.total), e5xx: Number(lastHour.e5xx), authFailed: Number(lastHour.authFailed) },
    };
  }

  /** Hours older than `date` go (run with the logs cleanup). */
  deleteOlderThan(date: Date): void {
    this.flush();
    this.db.prepare(`DELETE FROM _requests_hourly WHERE hour < ?`).run(stamp(date).slice(0, 13));
  }

  truncate(): void {
    this.#pending.clear();
    this.#minutes.clear();
    this.db.exec(`DELETE FROM _requests_hourly; DELETE FROM _requests_minutely`);
  }
}

const FLUSH_MS = 5_000;

export interface RequestFigures {
  total: number;
  e4xx: number;
  e5xx: number;
  authFailed: number;
  p50: number | null;
  p95: number | null;
}
export type RequestHour = RequestFigures & { date: string };
export interface RequestOverview {
  current: RequestFigures;
  previous: RequestFigures;
  hours: RequestHour[];
  /** The last 60 minutes, sliding (by the minute), for the 5xx and failed sign-in rules. */
  lastHour: { total: number; e5xx: number; authFailed: number };
}

type Hour = { total: number; e4xx: number; e5xx: number; authFailed: number; hist: Map<number, number> };
const emptyHour = (): Hour => ({ total: 0, e4xx: 0, e5xx: 0, authFailed: 0, hist: new Map() });

function merge(h: Hour, r: Record<string, unknown>) {
  h.total += Number(r.total ?? 0);
  h.e4xx += Number(r.e4xx ?? 0);
  h.e5xx += Number(r.e5xx ?? 0);
  h.authFailed += Number(r.authFailed ?? 0);
  let hist: Record<string, number> = {};
  try {
    hist = JSON.parse(String(r.hist ?? "{}"));
  } catch { /* a damaged row counts without latency */ }
  for (const [k, n] of Object.entries(hist)) h.hist.set(Number(k), (h.hist.get(Number(k)) ?? 0) + Number(n));
}

function figures(h: Hour): RequestFigures {
  const n = [...h.hist.values()].reduce((a, b) => a + b, 0);
  return {
    total: h.total,
    e4xx: h.e4xx,
    e5xx: h.e5xx,
    authFailed: h.authFailed,
    p50: histQuantile(h.hist, n, 0.5),
    p95: histQuantile(h.hist, n, 0.95),
  };
}
