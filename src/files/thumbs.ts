import type { BlobStore } from "./storage.ts";
import { readAll } from "./storage.ts";
import { type ThumbPool, thumbPool } from "./thumb_pool.ts";
import { decodeImage, encodeImage, fill, fit, MAX_THUMB_SIDE, resize } from "./image.ts";

/**
 * PB's thumbs (apis/file.go + filesystem.CreateThumb): generated lazily on the first `?thumb=` request, stored next
 * to the original as `<record dir>/thumbs_<filename>/<size>_<filename>` through whatever BlobStore is current (so
 * local and S3 alike, and the files migration moves them with the record dir).
 */

/** PB's filesystem.ThumbSizeRegex. */
export const THUMB_SIZE_RE = /^(\d+)x(\d+)(t|b|f)?$/;
/** PB's defaultThumbSizes: always allowed, whatever the field's thumbs option says. */
export const DEFAULT_THUMB_SIZES = ["100x100"];
/** PB's imageContentTypes: only these originals get a thumb; anything else is served as is. */
export const THUMB_CONTENT_TYPES = ["image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp"];

/** "thumbs_<filename>/" relative to the record dir: every thumb of one file, removed with it. */
export const thumbsDir = (filename: string) => `thumbs_${filename}/`;
export const thumbName = (size: string, filename: string) => `${size}_${filename}`;

/** Renders a thumb of `original` at `size` (PB's CreateThumb, image half). Returns the bytes and their type. */
export async function renderThumb(
  original: Uint8Array,
  originalType: string,
  size: string,
): Promise<{ bytes: Uint8Array; type: string }> {
  const m = THUMB_SIZE_RE.exec(size);
  if (!m) throw new Error("thumb size must be in WxH, WxHt, WxHb or WxHf format");
  const w = Number(m[1]), h = Number(m[2]);
  if (w === 0 && h === 0) throw new Error("thumb width and height cannot be zero at the same time");
  if (w > MAX_THUMB_SIDE || h > MAX_THUMB_SIDE) throw new Error(`thumb sides are capped at ${MAX_THUMB_SIDE}`);
  const img = await decodeImage(original);
  const out = w === 0 || h === 0
    ? resize(img, w, h)
    : m[3] === "f"
    ? fit(img, w, h)
    : fill(img, w, h, m[3] === "t" ? "top" : m[3] === "b" ? "bottom" : "center");
  // PB encodes by the original's stored type; anything else (webp, and "image/jpg") becomes PNG.
  switch (originalType) {
    case "image/jpeg":
      return { bytes: encodeImage(out, "jpeg"), type: "image/jpeg" };
    case "image/gif":
      return { bytes: encodeImage(out, "gif"), type: "image/gif" };
    default:
      return { bytes: encodeImage(out, "png"), type: "image/png" };
  }
}

/** PB's thumbGenMaxWait default: how long a request waits for a generation slot before falling back. */
const MAX_WAIT_MS = 60_000;

interface Generation {
  done: Promise<void>;
  abort: AbortController;
}

/**
 * The generator: one in-flight generation per thumb key (PB's singleflight) and at most `workers` rendering at once
 * (PB's semaphore), since a decode holds the whole bitmap in memory. Rendering runs on the worker pool. Generations are
 * registered by key so a file's replace or delete can cancel them and wait them out before removing its thumbs dir.
 */
export class Thumbs {
  #pending = new Map<string, Generation>();
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(readonly workers = 2, readonly maxWaitMs = MAX_WAIT_MS, readonly pool: ThumbPool = thumbPool()) {}

  /** Generations started and not yet settled, for tests. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /** Creates the thumb at thumbKey from originalKey; concurrent calls for one thumbKey share one generation. */
  create(storage: BlobStore, originalKey: string, thumbKey: string, size: string): Promise<void> {
    const running = this.#pending.get(thumbKey);
    if (running) return running.done;
    const abort = new AbortController();
    const g: Generation = { abort, done: Promise.resolve() };
    g.done = this.#generate(storage, originalKey, thumbKey, size, abort.signal).finally(() => {
      if (this.#pending.get(thumbKey) === g) this.#pending.delete(thumbKey);
    });
    this.#pending.set(thumbKey, g);
    return g.done;
  }

  /** Waits until no generation under `prefix` (a thumbs dir) is in flight; their outcome is not reported. */
  async settled(prefix: string): Promise<void> {
    const mine = [...this.#pending].filter(([k]) => k.startsWith(prefix)).map(([, g]) => g.done.catch(() => {}));
    await Promise.all(mine);
  }

  /**
   * Cancels every generation under `prefix` and waits them out: none writes after this resolves, and a put already
   * under way has landed, so a deletePrefix that follows leaves nothing behind.
   */
  cancel(prefix: string): Promise<void> {
    for (const [k, g] of this.#pending) if (k.startsWith(prefix)) g.abort.abort(new Error("thumb generation canceled"));
    return this.settled(prefix);
  }

  async #generate(
    storage: BlobStore,
    originalKey: string,
    thumbKey: string,
    size: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#acquire(signal);
    try {
      const obj = await storage.get(originalKey);
      if (!obj) throw new Error("original file not found");
      const bytes = await readAll(obj.body);
      signal.throwIfAborted();
      const thumb = await this.pool.render(bytes, obj.type.split(";")[0].trim(), size, signal);
      signal.throwIfAborted();
      await storage.put(thumbKey, thumb.bytes, { type: thumb.type });
      // Canceled during the put, or the original went without a cancel (another process): undo it.
      if (signal.aborted || !(await storage.stat(originalKey))) {
        await storage.delete(thumbKey);
        throw new Error("original file not found");
      }
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (this.#running < this.workers) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const take = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#running++;
        resolve();
      };
      const drop = (e: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#queue = this.#queue.filter((f) => f !== take);
        reject(e);
      };
      const onAbort = () => drop(new Error("thumb generation canceled"));
      const timer = setTimeout(() => drop(new Error("timed out waiting for a thumb generation slot")), this.maxWaitMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(take);
    });
  }

  #release(): void {
    this.#running--;
    this.#queue.shift()?.();
  }
}

const registry = new WeakMap<BlobStore, Thumbs>();
/**
 * The generator of one storage: the files route creates through it and a record write cancels through it, so both
 * see the same in-flight registry.
 */
export function thumbsFor(storage: BlobStore): Thumbs {
  let t = registry.get(storage);
  if (!t) registry.set(storage, t = new Thumbs(2));
  return t;
}
