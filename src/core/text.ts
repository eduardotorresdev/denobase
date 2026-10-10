/** PB tools/inflector.Snakecase: words split on non-word runs, camelCase humps split, lower-cased, joined by "_". */
export function snakecase(s: string): string {
  return s.split(/[\W_]+/u).filter(Boolean).map((w) =>
    [...w].map((c, i) => (i > 0 && c !== c.toLowerCase() && w[i - 1] === w[i - 1].toLowerCase() ? `_${c}` : c))
      .join("")
  ).join("_").toLowerCase();
}

/** The loose email shape every validation here uses (PB's is.EmailFormat role). */
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
