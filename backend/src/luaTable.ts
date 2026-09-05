// A parser for the small subset of Lua the wiki's calculator data modules are written in.
//
// `Module:Skill calc/<Skill>` is a plain `return { {...}, {...} }` table literal: string values in
// single quotes, numbers, and nested tables. Nothing else appears in any of the seventeen files,
// so a full Lua interpreter would be several orders of magnitude more machinery than the job
// needs. What it is NOT is a regex: `materials` nests tables inside tables, and matching braces
// with a regular expression is the classic way to silently mis-parse one entry in a thousand and
// never notice.

export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

class Cursor {
  constructor(
    readonly src: string,
    public i = 0,
  ) {}

  skip() {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
      // Lua line comments. Present in a few of these files as `-- levels 1-15`.
      if (this.src.startsWith("--", this.i)) {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skip();
    return this.src[this.i] ?? "";
  }

  expect(ch: string) {
    if (this.peek() !== ch) {
      throw new Error(`expected "${ch}" at ${this.i}, found "${this.src.slice(this.i, this.i + 20)}"`);
    }
    this.i++;
  }
}

function parseString(c: Cursor): string {
  const quote = c.src[c.i];
  c.i++;
  let out = "";
  while (c.i < c.src.length) {
    const ch = c.src[c.i];
    if (ch === "\\") {
      out += c.src[c.i + 1];
      c.i += 2;
      continue;
    }
    if (ch === quote) {
      c.i++;
      return out;
    }
    out += ch;
    c.i++;
  }
  throw new Error("unterminated string");
}

function parseValue(c: Cursor): LuaValue {
  const ch = c.peek();
  if (ch === "'" || ch === '"') return parseString(c);
  if (ch === "{") return parseTable(c);

  // Bare word: a number, a boolean, or nil. Anything else (a function call, a variable) would mean
  // this file stopped being data, which is worth failing loudly over rather than coercing to NaN.
  const start = c.i;
  while (c.i < c.src.length && !/[,}\n]/.test(c.src[c.i])) c.i++;
  const raw = c.src.slice(start, c.i).trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "nil") return null;
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;
  // A few quantities are written as arithmetic rather than a literal: Smithing has `1/140` of a
  // Blast Furnace fee per bar, Runecraft `(2/16 / 45)` of a pouch. Evaluated here rather than
  // dropped, because dropping the row would quietly delete Smithing and Runecraft entirely.
  const value = evalArithmetic(raw);
  if (value == null) throw new Error(`unparseable value "${raw}" at ${start}`);
  return value;
}

/** Whole-string evaluator for `+ - * / ( )` over decimal literals. Returns null on anything else. */
function evalArithmetic(expr: string): number | null {
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) return null;
  let i = 0;
  const skip = () => {
    while (i < expr.length && expr[i] === " ") i++;
  };
  function primary(): number {
    skip();
    if (expr[i] === "(") {
      i++;
      const v = sum();
      skip();
      if (expr[i] !== ")") throw new Error("unbalanced");
      i++;
      return v;
    }
    if (expr[i] === "-") {
      i++;
      return -primary();
    }
    const start = i;
    while (i < expr.length && /[\d.]/.test(expr[i])) i++;
    const n = Number(expr.slice(start, i));
    if (Number.isNaN(n)) throw new Error("not a number");
    return n;
  }
  function product(): number {
    let v = primary();
    for (;;) {
      skip();
      const op = expr[i];
      if (op !== "*" && op !== "/") return v;
      i++;
      const rhs = primary();
      v = op === "*" ? v * rhs : v / rhs;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      skip();
      const op = expr[i];
      if (op !== "+" && op !== "-") return v;
      i++;
      const rhs = product();
      v = op === "+" ? v + rhs : v - rhs;
    }
  }
  try {
    const v = sum();
    skip();
    return i === expr.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function parseTable(c: Cursor): LuaValue {
  c.expect("{");
  const array: LuaValue[] = [];
  const record: { [key: string]: LuaValue } = {};
  let named = false;

  for (;;) {
    if (c.peek() === "}") {
      c.i++;
      break;
    }
    // `key = value` versus a positional entry. A Lua table can hold both at once; these files
    // only ever use one or the other per table, so whichever appears first decides the shape.
    const save = c.i;
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(c.src.slice(c.i));
    if (keyMatch) {
      c.i += keyMatch[0].length;
      record[keyMatch[1]] = parseValue(c);
      named = true;
    } else {
      c.i = save;
      array.push(parseValue(c));
    }
    const sep = c.peek();
    if (sep === "," || sep === ";") c.i++;
  }
  return named ? record : array;
}

/** Parse a `return { ... }` module body into plain JS values. Throws on anything unexpected. */
export function parseLuaReturnTable(source: string): LuaValue {
  const at = source.indexOf("return");
  if (at === -1) throw new Error("no return statement");
  const c = new Cursor(source, at + "return".length);
  return parseTable(c);
}
