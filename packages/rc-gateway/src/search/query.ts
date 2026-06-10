/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A pure query language for the on-demand transcript scan (`searchTranscripts`).
 * Supports phrase quoting, boolean `OR`/`AND`/`NOT`, a `term*` prefix wildcard,
 * and parenthesised grouping, parsed to a boolean AST and evaluated recursively
 * against a record's lowercased searchable text. See the cycle-32 design doc for
 * the grammar and the deviations from the proposal's FTS5 syntax.
 *
 * Operators are UPPERCASE-ONLY (`OR`, `AND`, `NOT`); lowercase `or`/`and`/`not`
 * are ordinary terms, so every all-lowercase query WITHOUT parens stays a
 * pure-AND substring search (back-compat with cycle 19). Precedence: `OR`
 * lowest, then implicit `AND`, then `NOT`/atom/parens. The parser is total — it
 * never throws and never loops.
 *
 * NOTE (cycle-32 deviation): bare `(`/`)` are now grouping syntax, so a literal
 * paren must be phrase-quoted (`"getUser("`) to match as a substring.
 */

/** One compiled atom. `value` is already lowercased (phrase: whitespace-normalized). */
export interface QueryTerm {
  kind: 'plain' | 'phrase' | 'prefix';
  value: string;
}

/** A boolean expression node. `not` negates its single child. */
export type QueryNode =
  | { t: 'and' | 'or'; kids: QueryNode[] }
  | { t: 'not'; kid: QueryNode }
  | { t: 'atom'; term: QueryTerm };

/** A compiled query: a boolean tree (or `null` = empty query → matches nothing). */
export interface QueryPlan {
  node: QueryNode | null;
  /**
   * The first effectively-non-negated atom's literal (lowercased) for snippet
   * centering, or `''` when the query is all-negation / empty.
   * `searchTranscripts` passes this to `snippet(text, seed)`.
   */
  seed: string;
}

type Token =
  | { type: 'word'; text: string }
  | { type: 'phrase'; text: string }
  | { type: 'lparen' }
  | { type: 'rparen' };

const WS = /\s/;

/**
 * Split a query into word / phrase / paren tokens. A `"` opens a phrase that
 * runs to the next `"` or end-of-input (unclosed → phrase-to-end, never an
 * error); `(` and `)` are their own tokens (so `(abc` → `lparen` + word `abc`);
 * otherwise a run of non-whitespace, non-`"`, non-paren characters is a word.
 */
function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    // Skip whitespace using the SAME predicate the word-scanner stops on — a
    // mismatch leaves a char that is neither skipped nor consumed, so the loop
    // spins forever on an interior NBSP/\v/\f/Unicode space.
    if (WS.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const close = q.indexOf('"', i + 1);
      if (close < 0) {
        tokens.push({ type: 'phrase', text: q.slice(i + 1) });
        break;
      }
      tokens.push({ type: 'phrase', text: q.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    // A word: run up to the next whitespace, quote, or paren.
    let j = i;
    while (
      j < q.length &&
      !WS.test(q[j]) &&
      q[j] !== '"' &&
      q[j] !== '(' &&
      q[j] !== ')'
    )
      j++;
    tokens.push({ type: 'word', text: q.slice(i, j) });
    i = j;
  }
  return tokens;
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build an atom term from a word's text, or null when it carries no value. */
function wordTerm(text: string): QueryTerm | null {
  if (text.endsWith('*')) {
    const value = text.slice(0, -1).toLowerCase();
    return value ? { kind: 'prefix', value } : null;
  }
  const value = text.toLowerCase();
  return value ? { kind: 'plain', value } : null;
}

/**
 * Parse a query string into a {@link QueryPlan}. Total (never throws, never
 * loops): every recursion either consumes a token or the caller's guard stops
 * it, and a `pos === before` safety break in the AND-loop guarantees progress.
 */
export function parseQuery(q: string): QueryPlan {
  const tokens = tokenize(q);
  let pos = 0;
  let seed = '';

  const peek = (): Token | undefined => tokens[pos];
  const isWord = (t: Token | undefined, text: string): boolean =>
    t !== undefined && t.type === 'word' && t.text === text;

  // Record the first effectively-positive atom's value for snippet centering.
  const recordSeed = (term: QueryTerm, effNeg: boolean): void => {
    if (!effNeg && seed === '') seed = term.value;
  };

  // OR has the lowest precedence: a sequence of AND-groups separated by `OR`.
  const parseOr = (effNeg: boolean): QueryNode | null => {
    const kids: QueryNode[] = [];
    const first = parseAnd(effNeg);
    if (first) kids.push(first);
    while (isWord(peek(), 'OR')) {
      pos++; // consume OR
      const next = parseAnd(effNeg);
      if (next) kids.push(next);
    }
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    return { t: 'or', kids };
  };

  // Implicit AND between adjacent atoms; `AND` keyword is an accepted no-op.
  // Stops at `OR`, `)`, or end-of-input.
  const parseAnd = (effNeg: boolean): QueryNode | null => {
    const kids: QueryNode[] = [];
    for (;;) {
      const t = peek();
      if (t === undefined || t.type === 'rparen' || isWord(t, 'OR')) break;
      if (isWord(t, 'AND')) {
        pos++; // no-op separator
        continue;
      }
      const before = pos;
      const atom = parseAtom(effNeg);
      if (atom) kids.push(atom);
      if (pos === before) break; // safety: guarantee progress (totality)
    }
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    return { t: 'and', kids };
  };

  const parseAtom = (effNeg: boolean): QueryNode | null => {
    const t = peek();
    if (t === undefined || t.type === 'rparen') return null;

    if (t.type === 'lparen') {
      pos++; // consume (
      const inner = parseOr(effNeg);
      if (peek()?.type === 'rparen') pos++; // consume optional closing )
      return inner;
    }

    // NOT / lone `-` prefix → negate the following atom (which may be a group).
    if (isWord(t, 'NOT') || isWord(t, '-')) {
      pos++;
      const kid = parseAtom(!effNeg);
      return kid ? { t: 'not', kid } : null;
    }

    if (t.type === 'phrase') {
      pos++;
      const value = t.text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!value) return null;
      const term: QueryTerm = { kind: 'phrase', value };
      recordSeed(term, effNeg);
      return { t: 'atom', term };
    }

    // A word atom, possibly with a leading `-` (negation) and/or trailing `*`.
    pos++;
    let text = t.text;
    let neg = false;
    if (text.startsWith('-')) {
      neg = true;
      text = text.slice(1);
    }
    const term = wordTerm(text);
    if (!term) return null;
    recordSeed(term, neg ? !effNeg : effNeg);
    const atom: QueryNode = { t: 'atom', term };
    return neg ? { t: 'not', kid: atom } : atom;
  };

  const node = parseOr(false);
  return { node, seed };
}

/**
 * Compiled prefix regexes, cached per term object. A plan's term objects persist
 * for the whole `searchTranscripts` scan, so the regex is built once (not once
 * per record). Keyed by a WeakMap so the `QueryTerm` data shape stays plain.
 */
const prefixRegexes = new WeakMap<QueryTerm, RegExp>();

function prefixRegex(t: QueryTerm): RegExp {
  let re = prefixRegexes.get(t);
  if (re === undefined) {
    // Word-boundary prefix: a token starting with the stem. The stem is escaped
    // and followed by no quantifier → a linear, ReDoS-safe literal match.
    re = new RegExp('\\b' + escapeRegExp(t.value));
    prefixRegexes.set(t, re);
  }
  return re;
}

/** Does a single atom term match the (already lowercased) haystack? */
function termMatch(t: QueryTerm, hayLower: string): boolean {
  if (t.kind === 'prefix') return prefixRegex(t).test(hayLower);
  // plain and phrase are both substring matches.
  return hayLower.includes(t.value);
}

function evalNode(node: QueryNode, hayLower: string): boolean {
  switch (node.t) {
    case 'atom':
      return termMatch(node.term, hayLower);
    case 'not':
      return !evalNode(node.kid, hayLower);
    case 'and':
      return node.kids.every((k) => evalNode(k, hayLower));
    case 'or':
      return node.kids.some((k) => evalNode(k, hayLower));
    default:
      return false; // unreachable: the union above is exhaustive.
  }
}

/**
 * Evaluate a compiled plan against a record's lowercased searchable text. An
 * empty plan (`node === null`) never matches.
 */
export function matchesQuery(plan: QueryPlan, hayLower: string): boolean {
  if (plan.node === null) return false;
  return evalNode(plan.node, hayLower);
}
