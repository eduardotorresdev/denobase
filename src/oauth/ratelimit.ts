/** In-memory fixed-window limiter per key (PB's rate limiter is per process too). */
export class RateLimiter {
  readonly #hits = new Map<string, { n: number; reset: number }>();

  /** true when this hit is within max per windowMs for key. */
  hit(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
    if (this.#hits.size > 10_000) {
      for (const [k, v] of this.#hits) if (v.reset <= now) this.#hits.delete(k);
    }
    const cur = this.#hits.get(key);
    if (!cur || cur.reset <= now) {
      this.#hits.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    cur.n++;
    return cur.n <= max;
  }

  /** Hits of key in its current window, without counting one (for limits that only count failures). */
  count(key: string, now: number = Date.now()): number {
    const cur = this.#hits.get(key);
    return cur && cur.reset > now ? cur.n : 0;
  }
}

/**
 * Delay before checking a credential of an account that failed `n` times in the window, from any IP. A delay and not
 * a refusal: anyone can fail on someone else's email, and a refusal would lock the real user out of the page.
 */
export function failureDelayMs(n: number): number {
  const free = LIMITS.accountFail[0];
  return n < free ? 0 : Math.min(250 * 2 ** (n - free), 4_000);
}

/** The limits of the authorization server's public endpoints. */
export const LIMITS = {
  token: [30, 60_000],
  register: [10, 3_600_000],
  /** Every login or code check of one IP. */
  login: [10, 60_000],
  /** Failed checks of one account from one IP: a hard stop that a stranger elsewhere cannot trigger. */
  loginFail: [10, 60_000],
  /** Failed checks of one account from any IP: past the first ones, each check waits (failureDelayMs). */
  accountFail: [5, 15 * 60_000],
  /** Codes sent per IP, and per email from one IP. */
  otp: [3, 60_000],
  /** Codes sent to one email from any IP (mailbox flooding). Only codes stop; the password still works. */
  otpEmail: [10, 3_600_000],
} as const;
