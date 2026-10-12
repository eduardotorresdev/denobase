import type { BlobStore } from "./storage.ts";
import { readAll } from "./storage.ts";
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

/**
 * The generator: one in-flight generation per thumb key (PB's singleflight) and at most `workers` decoding at once
 * (PB's semaphore), since a decode holds the whole bitmap in memory.
 */
export class Thumbs {
  #pending = new Map<string, Promise<void>>();
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(readonly workers = 2, readonly maxWaitMs = MAX_WAIT_MS) {}

  /** Generations started and not yet settled, for tests. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /** Creates the thumb at thumbKey from originalKey; concurrent calls for one thumbKey share one generation. */
  create(storage: BlobStore, originalKey: string, thumbKey: string, size: string): Promise<void> {
    const running = this.#pending.get(thumbKey);
    if (running) return running;
    const p = this.#generate(storage, originalKey, thumbKey, size).finally(() => this.#pending.delete(thumbKey));
    this.#pending.set(thumbKey, p);
    return p;
  }

  async #generate(storage: BlobStore, originalKey: string, thumbKey: string, size: string): Promise<void> {
    await this.#acquire();
    try {
      const obj = await storage.get(originalKey);
      if (!obj) throw new Error("original file not found");
      const bytes = await readAll(obj.body);
      const thumb = await renderThumb(bytes, obj.type.split(";")[0].trim(), size);
      await storage.put(thumbKey, thumb.bytes, { type: thumb.type });
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#running < this.workers) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const take = () => {
        clearTimeout(timer);
        this.#running++;
        resolve();
      };
      const timer = setTimeout(() => {
        this.#queue = this.#queue.filter((f) => f !== take);
        reject(new Error("timed out waiting for a thumb generation slot"));
      }, this.maxWaitMs);
      this.#queue.push(take);
    });
  }

  #release(): void {
    this.#running--;
    this.#queue.shift()?.();
  }
}
