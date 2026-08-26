// MediaWiki `{{#expr:}}` values, evaluated locally.
//
// The money-making guides carry quantities as expressions rather than numbers -- `{{#expr:2*(1)}}`,
// `{{#expr:2*2.5*(1/30)}}`, `{{#expr:750*1.2*4}}` -- because they are derived from drop rates.
//
// Evaluated with a hand-written recursive-descent parser rather than `eval` or `new Function`.
// This input comes off the public internet: an editor can put anything between those braces, and
// handing that to a JS evaluator would be remote code execution with extra steps. A parser that
// only knows how to add cannot be talked into anything else.
//
// Anything outside plain arithmetic returns null, and the caller skips the row rather than
// guessing a quantity. A wrong quantity here silently becomes a wrong gp/hr.

type Tok = { t: "num"; v: number } | { t: "op"; v: string };

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) return null;
      toks.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if ("+-*/()".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    // A named function (round, floor, trunc, ...) or anything else: refuse the whole expression.
    return null;
  }
  return toks;
}

export function evalWikiExpr(raw: string): number | null {
  const toks = tokenize(raw);
  if (!toks || toks.length === 0) return null;

  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];

  function expr(): number | null {
    let left = term();
    if (left == null) return null;
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        pos++;
        const right = term();
        if (right == null) return null;
        left = t.v === "+" ? left + right : left - right;
      } else {
        return left;
      }
    }
  }

  function term(): number | null {
    let left = unary();
    if (left == null) return null;
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
        pos++;
        const right = unary();
        if (right == null) return null;
        if (t.v === "/" && right === 0) return null;
        left = t.v === "*" ? left * right : left / right;
      } else {
        return left;
      }
    }
  }

  function unary(): number | null {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      pos++;
      const v = unary();
      return v == null ? null : t.v === "-" ? -v : v;
    }
    return atom();
  }

  function atom(): number | null {
    const t = peek();
    if (!t) return null;
    if (t.t === "num") {
      pos++;
      return t.v;
    }
    if (t.t === "op" && t.v === "(") {
      pos++;
      const v = expr();
      if (v == null) return null;
      const close = peek();
      if (!close || close.t !== "op" || close.v !== ")") return null;
      pos++;
      return v;
    }
    return null;
  }

  const value = expr();
  if (value == null || pos !== toks.length) return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * A quantity field, which may be a bare number or an `{{#expr:}}`.
 * Returns null when it cannot be read exactly -- never a guess.
 */
export function parseQuantity(
  raw: string | undefined,
  vars: Map<string, string> = new Map(),
): number | null {
  if (!raw) return null;
  const text = stripComments(raw).trim().replace(/,/g, "");
  if (!text) return null;
  // A plain number first, then the full resolver. Guides write quantities three ways -- "100",
  // "1/4" as bare arithmetic, and a wrapped {{#expr:}} -- and only the first was handled, so a
  // bare fraction became NaN and its line was dropped.
  const plain = Number(text);
  if (Number.isFinite(plain)) return plain;
  return resolveExpression(text, vars);
}

// ---------------------------------------------------------------------------------------------
// Page variables.
//
// Newer guides -- every recent boss, including the Doom of Mokhaiotl -- express drop rates through
// MediaWiki variables rather than literals:
//
//   {{#vardefine:unique4|1/450}}
//   {{#vardefine:common2|{{#expr:1-{{#var:unique2}}}}}}
//   |Output1num = {{#expr:({{#var:unique4}} + ...)}}
//
// Without resolving these, every quantity on those pages fails to parse and the guide is dropped
// or half-read. The Doom guides came through with 7 missing inputs and 25 missing outputs, which
// classified them "overstated" and hid them from the list entirely -- reported as "i don't see
// killing doom in my current list".
//
// Values are resolved iteratively because they reference each other; `common2` is defined in terms
// of `unique2`. A fixed number of passes rather than recursion, so a page that defines a variable
// in terms of itself terminates instead of hanging.

const MAX_RESOLVE_PASSES = 8;

/** HTML comments appear inline in quantity fields: `num=17 <!--ex. 6 larvae per...-->`. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every `{{#vardefine:name|value}}` on a page, values left unresolved. */
export function extractVarDefines(wikitext: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /\{\{\s*#vardefine\s*:\s*([^|}]+?)\s*\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext))) {
    // Read the value by brace depth rather than to the next "}}" -- the value itself frequently
    // contains a nested {{#expr:}}, and a lazy match would cut it in half.
    let depth = 1;
    let i = re.lastIndex;
    let value = "";
    while (i < wikitext.length && depth > 0) {
      if (wikitext.slice(i, i + 2) === "{{") {
        depth++;
        value += "{{";
        i += 2;
        continue;
      }
      if (wikitext.slice(i, i + 2) === "}}") {
        depth--;
        if (depth === 0) break;
        value += "}}";
        i += 2;
        continue;
      }
      value += wikitext[i];
      i++;
    }
    vars.set(m[1].trim(), value.trim());
  }
  return vars;
}

/**
 * Resolve `{{#var:}}` references and evaluate every `{{#expr:}}`, innermost first, until a plain
 * number remains. Returns null the moment anything cannot be resolved exactly.
 */
export function resolveExpression(raw: string, vars: Map<string, string>): number | null {
  let text = stripComments(raw).trim();
  if (!text) return null;

  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    // Substitute variables. An undefined variable is fatal rather than treated as zero: a drop
    // rate silently becoming 0 would understate a boss without any sign that it had happened.
    text = text.replace(/\{\{\s*#var:\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}/g, (_all, name: string) => {
      const v = vars.get(name.trim());
      return v == null ? "\u0000UNDEF\u0000" : `(${v})`;
    });
    if (text.includes("\u0000UNDEF\u0000")) return null;

    // Evaluate the innermost {{#expr:}} -- one with no further braces inside it.
    const innermost = text.match(/\{\{\s*#expr:\s*([^{}]*)\}\}/i);
    if (innermost) {
      const value = evalWikiExpr(innermost[1]);
      if (value == null) return null;
      text = text.replace(innermost[0], `(${value})`);
      continue;
    }

    if (text.includes("{{")) {
      // A template that is neither #var nor #expr ({{Cheap food}}, a drop-table transclusion).
      // Not a number, and not guessable.
      return null;
    }
    break;
  }

  if (text.includes("{{")) return null;
  return evalWikiExpr(text);
}
