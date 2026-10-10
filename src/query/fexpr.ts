/**
 * Tokenizer/parser PocketBase filters go through (fexpr v0.6.0 semantics). Kept close to
 * the reference behaviour (including its quirks: no precedence beyond SQL's, groups re-parsed from their raw text) so the
 * same strings are accepted and rejected.
 */

export type TokenType =
  | "unexpected"
  | "eof"
  | "whitespace"
  | "join"
  | "sign"
  | "identifier"
  | "function"
  | "number"
  | "text"
  | "group"
  | "comment";

export interface Token {
  type: TokenType;
  literal: string;
  /** Function arguments. */
  args?: Token[];
}

export type SignOp =
  | "="
  | "!="
  | "~"
  | "!~"
  | "<"
  | "<="
  | ">"
  | ">="
  | "?="
  | "?!="
  | "?~"
  | "?!~"
  | "?<"
  | "?<="
  | "?>"
  | "?>=";
export type JoinOp = "&&" | "||";

export interface Expr {
  left: Token;
  op: SignOp;
  right: Token;
}
export interface ExprGroup {
  join: JoinOp;
  item: Expr | ExprGroup[];
}

export class FexprError extends Error {}

const SIGNS = new Set(["=", "!=", "~", "!~", "<", "<=", ">", ">=", "?=", "?!=", "?~", "?!~", "?<", "?<=", "?>", "?>="]);
const EOF = "";

const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\n";
const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";
const isText = (c: string) => c === "'" || c === '"';
const isNumberStart = (c: string) => c === "-" || isDigit(c);
const isSignStart = (c: string) => "=?!><~".includes(c) && c !== "";
const isJoinStart = (c: string) => c === "&" || c === "|";
const isGroupStart = (c: string) => c === "(";
const isCommentStart = (c: string) => c === "/";
const isSpecialStart = (c: string) => c === "@" || c === "_" || c === "#";
const isIdentStart = (c: string) => isLetter(c) || isSpecialStart(c);
const isCombine = (c: string) => c === "." || c === ":";

function isValidIdentifier(s: string): boolean {
  return s.length > 0 && !isCombine(s[s.length - 1]) && (s.length !== 1 || !isSpecialStart(s[0]));
}

export class Scanner {
  private pos = 0;
  private last = -1;
  private readonly data: string[];

  constructor(text: string, private readonly maxFuncDepth = 3) {
    this.data = [...text];
  }

  scan(): Token {
    const ch = this.read();
    if (ch === EOF) return { type: "eof", literal: "" };
    this.unread();
    if (isWhitespace(ch)) return this.scanWhitespace();
    if (isGroupStart(ch)) return this.scanGroup();
    if (isIdentStart(ch)) return this.scanIdentifier(this.maxFuncDepth);
    if (isNumberStart(ch)) return this.scanNumber();
    if (isText(ch)) return this.scanText(false);
    if (isSignStart(ch)) return this.scanSign();
    if (isJoinStart(ch)) return this.scanJoin();
    if (isCommentStart(ch)) return this.scanComment();
    this.read();
    throw new FexprError(`unexpected character ${JSON.stringify(ch)}`);
  }

  private read(): string {
    if (this.pos >= this.data.length) {
      this.last = -1;
      return EOF;
    }
    this.last = 1;
    return this.data[this.pos++];
  }

  private unread(): void {
    if (this.last < 0) return;
    this.pos -= this.last;
    this.last = -1;
  }

  private scanWhile(pred: (c: string) => boolean): string {
    let buf = "";
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (!pred(ch)) {
        this.unread();
        break;
      }
      buf += ch;
    }
    return buf;
  }

  private scanWhitespace(): Token {
    return { type: "whitespace", literal: this.scanWhile(isWhitespace) };
  }

  scanNumber(): Token {
    let buf = "";
    let hadDot = false;
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (!isDigit(ch) && (ch !== "-" || buf.length !== 0) && (ch !== "." || hadDot)) {
        this.unread();
        break;
      }
      buf += ch;
      if (ch === ".") hadDot = true;
    }
    if ((buf === "-") || buf[0] === "." || buf[buf.length - 1] === ".") {
      throw new FexprError(`invalid number ${JSON.stringify(buf)}`);
    }
    return { type: "number", literal: buf };
  }

  scanText(preserveQuotes: boolean): Token {
    let buf = "";
    const first = this.read();
    if (preserveQuotes) buf += first;
    let escapeNext = false;
    let matched = false;
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (escapeNext) {
        escapeNext = false;
        if (preserveQuotes) buf += ch;
        else if (ch === "n") buf += "\n";
        else if (ch === "t") buf += "\t";
        else if (ch === "r") buf += "\r";
        else if (ch === "\\" || ch === "'" || ch === '"') buf += ch;
        else buf += "\\" + ch;
      } else if (ch === "\\") {
        escapeNext = true;
        if (preserveQuotes) buf += ch;
      } else if (ch === first) {
        matched = true;
        if (preserveQuotes) buf += ch;
        break;
      } else buf += ch;
    }
    if (!matched) throw new FexprError(`invalid quoted text ${JSON.stringify(buf)}`);
    return { type: "text", literal: buf };
  }

  private scanComment(): Token {
    if (!isCommentStart(this.read()) || !isCommentStart(this.read())) throw new FexprError("invalid comment");
    let buf = "";
    for (;;) {
      const ch = this.read();
      if (ch === EOF || ch === "\n") break;
      buf += ch;
    }
    return { type: "comment", literal: buf.trim() };
  }

  scanIdentifier(funcDepth: number): Token {
    let buf = this.read();
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (ch === "(") {
        if (funcDepth <= 0) throw new FexprError(`max nested function arguments reached (max: ${this.maxFuncDepth})`);
        if (!isValidIdentifier(buf)) throw new FexprError(`invalid function name ${JSON.stringify(buf)}`);
        this.unread();
        return this.scanFunctionArgs(buf, funcDepth);
      }
      if (!isLetter(ch) && !isDigit(ch) && !isCombine(ch) && ch !== "_") {
        this.unread();
        break;
      }
      buf += ch;
    }
    if (!isValidIdentifier(buf)) throw new FexprError(`invalid identifier ${JSON.stringify(buf)}`);
    return { type: "identifier", literal: buf };
  }

  private scanSign(): Token {
    const lit = this.scanWhile(isSignStart);
    if (!SIGNS.has(lit)) throw new FexprError(`invalid sign operator ${JSON.stringify(lit)}`);
    return { type: "sign", literal: lit };
  }

  private scanJoin(): Token {
    const lit = this.scanWhile(isJoinStart);
    if (lit !== "&&" && lit !== "||") throw new FexprError(`invalid join operator ${JSON.stringify(lit)}`);
    return { type: "join", literal: lit };
  }

  private scanGroup(): Token {
    let buf = "";
    this.read();
    let open = 1;
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (isGroupStart(ch)) {
        open++;
        buf += ch;
      } else if (isText(ch)) {
        this.unread();
        buf += this.scanText(true).literal;
      } else if (ch === ")") {
        open--;
        if (open <= 0) break;
        buf += ch;
      } else buf += ch;
    }
    if (open > 0) throw new FexprError(`invalid formatted group - missing ${open} closing bracket(s)`);
    return { type: "group", literal: buf };
  }

  private scanFunctionArgs(name: string, funcDepth: number): Token {
    const args: Token[] = [];
    let expectComma = false;
    let closed = false;
    if (this.read() !== "(") throw new FexprError(`invalid or incomplete function call ${JSON.stringify(name)}`);
    for (;;) {
      const ch = this.read();
      if (ch === EOF) break;
      if (ch === ")") {
        closed = true;
        break;
      }
      if (isWhitespace(ch)) {
        this.scanWhitespace();
        continue;
      }
      if (isCommentStart(ch)) {
        this.unread();
        this.scanComment();
        continue;
      }
      const isComma = ch === ",";
      if (expectComma && !isComma) throw new FexprError(`expected comma after the last argument in ${name}`);
      if (!expectComma && isComma) throw new FexprError(`unexpected comma in function ${name}`);
      expectComma = false;
      if (isComma) continue;
      this.unread();
      if (isIdentStart(ch)) args.push(this.scanIdentifier(funcDepth - 1));
      else if (isNumberStart(ch)) args.push(this.scanNumber());
      else if (isText(ch)) args.push(this.scanText(false));
      else throw new FexprError(`unsupported argument character ${JSON.stringify(ch)} in function ${name}`);
      expectComma = true;
    }
    if (!closed) throw new FexprError(`invalid or incomplete function ${JSON.stringify(name)} (expected ')')`);
    return { type: "function", literal: name, args };
  }
}

const OPERAND = new Set<TokenType>(["identifier", "text", "number", "function"]);

/** fexpr.Parse: a flat list of AND/OR joined expressions and groups; "" (or only comments) is an error. */
export function parse(text: string): ExprGroup[] {
  const result: ExprGroup[] = [];
  const scanner = new Scanner(text);
  let step: "before" | "sign" | "after" | "join" = "before";
  let join: JoinOp = "&&";
  let left: Token | undefined;
  let op: SignOp | undefined;
  for (;;) {
    const t = scanner.scan();
    if (t.type === "eof") break;
    if (t.type === "whitespace" || t.type === "comment") continue;
    if (t.type === "group") {
      const sub = parse(t.literal);
      if (sub.length > 0) result.push({ join, item: sub });
      step = "join";
      continue;
    }
    switch (step) {
      case "before":
        if (!OPERAND.has(t.type)) throw new FexprError(`expected left operand, got ${JSON.stringify(t.literal)}`);
        left = t;
        op = undefined;
        step = "sign";
        break;
      case "sign":
        if (t.type !== "sign") throw new FexprError(`expected a sign operator, got ${JSON.stringify(t.literal)}`);
        op = t.literal as SignOp;
        step = "after";
        break;
      case "after":
        if (!OPERAND.has(t.type)) throw new FexprError(`expected right operand, got ${JSON.stringify(t.literal)}`);
        result.push({ join, item: { left: left!, op: op!, right: t } });
        step = "join";
        break;
      case "join":
        if (t.type !== "join") throw new FexprError(`expected && or ||, got ${JSON.stringify(t.literal)}`);
        join = t.literal as JoinOp;
        step = "before";
    }
  }
  if (step !== "join") {
    throw new FexprError(result.length === 0 && !left ? "empty filter expression" : "invalid or incomplete filter");
  }
  return result;
}
