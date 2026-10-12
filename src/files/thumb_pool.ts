/**
 * A fixed pool of Web Workers (thumb_worker.ts) for thumb rendering. Workers are spawned on first use and kept warm;
 * one that passes the timeout is terminated (the only way to stop a runaway decode) and a fresh one takes its seat.
 */

export interface ThumbJob {
  id: number;
  bytes: Uint8Array;
  type: string;
  size: string;
}
export type ThumbResult = { id: number; ok: true; bytes: Uint8Array; type: string } | {
  id: number;
  ok: false;
  message: string;
};

const WORKER = new URL("./thumb_worker.ts", import.meta.url);
/** Long enough for an image at the pixel guard on a slow core; past it the original is served. */
const RENDER_TIMEOUT_MS = 30_000;

interface Pending {
  job: ThumbJob;
  resolve: (r: { bytes: Uint8Array; type: string }) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}

interface Seat {
  worker: Worker | null;
  busy: Pending | null;
  timer?: ReturnType<typeof setTimeout>;
}

export class ThumbTimeoutError extends Error {}

export class ThumbPool {
  #seats: Seat[];
  #queue: Pending[] = [];
  #nextId = 1;
  /** Workers spawned so far, replacements included; for tests. */
  spawned = 0;

  constructor(readonly size = 2, public timeoutMs = RENDER_TIMEOUT_MS) {
    this.#seats = Array.from({ length: size }, () => ({ worker: null, busy: null }));
  }

  /**
   * Renders in a worker. `bytes` is transferred: the caller's buffer is detached afterwards. An aborted signal drops
   * a queued job and rejects a running one at once (the worker finishes it and the result is discarded).
   */
  render(
    bytes: Uint8Array,
    type: string,
    size: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; type: string }> {
    if (signal?.aborted) return Promise.reject(new Error("thumb generation canceled"));
    return new Promise((resolve, reject) => {
      const p: Pending = { job: { id: this.#nextId++, bytes, type, size }, resolve, reject, signal };
      signal?.addEventListener("abort", () => {
        const q = this.#queue.indexOf(p);
        if (q >= 0) this.#queue.splice(q, 1);
        reject(new Error("thumb generation canceled"));
      }, { once: true });
      this.#queue.push(p);
      this.#pump();
    });
  }

  /** Terminates every worker; the next render spawns fresh ones. */
  close(): void {
    for (const s of this.#seats) this.#retire(s, new Error("thumb pool closed"));
  }

  #pump(): void {
    for (const seat of this.#seats) {
      if (seat.busy) continue;
      const p = this.#queue.shift();
      if (!p) return;
      this.#start(seat, p);
    }
  }

  #start(seat: Seat, p: Pending): void {
    const w = seat.worker ??= this.#spawn(seat);
    seat.busy = p;
    seat.timer = setTimeout(() => {
      this.#retire(seat, new ThumbTimeoutError(`thumb rendering passed ${this.timeoutMs}ms`));
      this.#pump();
    }, this.timeoutMs);
    // Transfer only a buffer the view covers whole; a view into a larger buffer would hand the rest over too.
    let { bytes } = p.job;
    if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
    w.postMessage({ ...p.job, bytes }, [bytes.buffer as ArrayBuffer]);
    p.job.bytes = new Uint8Array(0);
  }

  #spawn(seat: Seat): Worker {
    this.spawned++;
    const w = new Worker(WORKER, { type: "module" });
    w.onmessage = (e: MessageEvent<ThumbResult>) => {
      const p = seat.busy;
      if (!p || p.job.id !== e.data.id) return;
      this.#settle(seat);
      if (e.data.ok) p.resolve({ bytes: e.data.bytes, type: e.data.type });
      else p.reject(new Error(e.data.message));
      this.#pump();
    };
    w.onerror = (e) => {
      e.preventDefault();
      this.#retire(seat, new Error(e.message || "thumb worker crashed"));
      this.#pump();
    };
    return w;
  }

  #settle(seat: Seat): void {
    clearTimeout(seat.timer);
    seat.busy = null;
  }

  #retire(seat: Seat, err: Error): void {
    const p = seat.busy;
    this.#settle(seat);
    seat.worker?.terminate();
    seat.worker = null;
    p?.reject(err);
  }
}

let shared: ThumbPool | undefined;
/** The process's pool: workers are threads, so one set serves every app and storage. */
export const thumbPool = (): ThumbPool => shared ??= new ThumbPool(2);
