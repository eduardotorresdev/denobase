import { encode as encodePng } from "fast-png";
import type { Rgba } from "./image.ts";

/** Image fixtures for the thumb tests. */

/** Two-color image: split vertically (left/right) or horizontally (top/bottom). */
export function twoTone(w: number, h: number, split: "lr" | "tb"): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const first = split === "lr" ? x < w / 2 : y < h / 2;
      data.set(first ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

export const pngOf = (img: Rgba): Uint8Array<ArrayBuffer> =>
  new Uint8Array(encodePng({ ...img, channels: 4, depth: 8 }));
