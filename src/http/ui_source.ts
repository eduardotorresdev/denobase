import { UI_ASSETS } from "./ui_assets.ts";

/** Content types of the files the admin UI and the OAuth pages serve. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

/** The content type served for a UI path, by extension. */
export function uiContentType(path: string): string {
  return TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";
}

/** A UI file: its bytes and the content type to serve them with. */
export interface UiFile {
  type: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Where the UI files come from: a directory on disk or the map embedded in the package. */
export interface UiSource {
  /** The file at a path relative to the UI root; null when absent or not a file. */
  read(path: string): Promise<UiFile | null>;
}

/** Reads the UI from a directory, so edits show up without a rebuild. */
export function diskUi(dir: string | URL): UiSource {
  const root = typeof dir === "string" ? dir.replace(/\/+$/, "") : decodeURIComponent(dir.pathname).replace(/\/+$/, "");
  return {
    async read(path) {
      try {
        return { type: uiContentType(path), data: await Deno.readFile(`${root}/${path}`) };
      } catch {
        return null;
      }
    },
  };
}

const decoded = new Map<string, Uint8Array<ArrayBuffer>>();

/** The UI embedded at build time (src/http/ui_assets.ts), for when the package is not on a local disk (JSR). */
export const embeddedUi: UiSource = {
  read(path) {
    const entry = Object.hasOwn(UI_ASSETS, path) ? UI_ASSETS[path] : undefined;
    if (!entry) return Promise.resolve(null);
    let data = decoded.get(path);
    if (!data) {
      data = Uint8Array.from(atob(entry.data), (c) => c.charCodeAt(0));
      decoded.set(path, data);
    }
    return Promise.resolve({ type: entry.type, data });
  },
};

/** The UI for a package root URL: from disk when it is a file: URL, otherwise (https, from JSR) embedded. */
export function uiSourceFor(root: URL): UiSource {
  return root.protocol === "file:" ? diskUi(root) : embeddedUi;
}

/** The UI shipped with this package (denobase/ui). */
export function bundledUi(): UiSource {
  return uiSourceFor(new URL("../../ui/", import.meta.url));
}
