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
export function parseQuantity(raw: string | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  const expr = text.match(/^\{\{\s*#expr:\s*([^}]*)\}\}$/i);
  if (expr) return evalWikiExpr(expr[1]);
  const plain = Number(text.replace(/,/g, ""));
  return Number.isFinite(plain) ? plain : null;
}
