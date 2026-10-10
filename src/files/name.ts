import { snakecase } from "../core/text.ts";

/** PB's file name normalization and its helpers. */

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function random(n: number): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => RANDOM_ALPHABET[x % RANDOM_ALPHABET.length]).join("");
}

/** The extension with a leading dot, double ones included (".tar.gz"), like PB's extractExtension. */
function extension(name: string): string {
  const primary = name.lastIndexOf(".");
  if (primary === -1) return "";
  const secondary = name.lastIndexOf(".", primary - 1);
  return name.slice(secondary >= 0 ? secondary : primary);
}

/** "<snake name>_<10 random>.<ext>", so uploads never collide or carry path tricks. */
export function normalizeName(original: string): string {
  const name = original.length > 300 ? original.slice(-300) : original;
  const ext = extension(name);
  let cleanExt = "." + ext.replace(/[^\w.*\-+=#]+/g, "").replace(/^\.+|\.+$/g, "");
  if (cleanExt === ".") cleanExt = "";
  if (cleanExt.length > 20) cleanExt = "." + cleanExt.slice(-20).replace(/^\.+|\.+$/g, "");
  let clean = snakecase(name.slice(0, name.length - ext.length).replace(/^\.+|\.+$/g, ""));
  if (clean.length < 3) clean += random(10);
  else if (clean.length > 100) clean = clean.slice(0, 100);
  return `${clean}_${random(10)}${cleanExt}`;
}
