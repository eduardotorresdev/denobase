/**
 * Paths that carry a credential in a segment (a webhook whose only auth is a secret in its URL): the activity log and
 * the request span would otherwise store it in clear text. A consumer registers the route pattern; every `:param`
 * segment of a matching path is written as `***`, the static segments are kept so the line still says what was hit.
 */
export const REDACTED_SEGMENT = "***";

const split = (path: string) => path.split("/");

export class PathRedactor {
  #patterns: string[][] = [];

  /** A Hono-style route pattern (`/api/hooks/:secret`); each `:param` segment is masked in matching paths. */
  add(pattern: string): void {
    const parts = split(pattern);
    if (!parts.some((p) => p.startsWith(":"))) throw new Error(`redactPath: "${pattern}" has no :param to mask`);
    this.#patterns.push(parts);
  }

  /**
   * The path with the params of the first matching pattern masked; any other path as it came. A pattern matches as a
   * prefix too: a trailing slash or extra segments (a 404 the route never answered) must not leak the secret either.
   */
  redact(path: string): string {
    if (!this.#patterns.length) return path;
    const parts = split(path);
    for (const pattern of this.#patterns) {
      if (parts.length < pattern.length) continue;
      if (!pattern.every((p, i) => p.startsWith(":") || p === parts[i])) continue;
      return parts.map((s, i) => (pattern[i]?.startsWith(":") ? REDACTED_SEGMENT : s)).join("/");
    }
    return path;
  }
}
