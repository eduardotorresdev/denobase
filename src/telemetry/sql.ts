const MAX = 2048;
const TOKENS = /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/**
 * db.query.text as OTel wants it: no comments and no literal values (they may carry PII), whitespace collapsed,
 * `IN (?, ?, ...)` folded so the same statement groups under one text, cut at 2KB. userSql is for SQL someone typed
 * (the guarded queries): SQLite reads a double-quoted word that names no column as a string literal, so those go too.
 */
export function normalizeSql(sql: string, opts: { userSql?: boolean } = {}): string {
  // One pass, so a quote inside a comment or a `--` inside a string is read as what it is.
  let s = sql
    .replace(TOKENS, (m) => m[0] === "'" ? "?" : m[0] === '"' ? (opts.userSql ? "?" : m) : " ")
    .replace(/\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)");
  if (s.length > MAX) s = s.slice(0, MAX - 3) + "...";
  return s;
}
