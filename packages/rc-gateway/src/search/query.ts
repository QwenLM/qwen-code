/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A pure query language for the on-demand transcript scan (`searchTranscripts`).
 * Supports phrase quoting, boolean `OR`/`NOT`, and a `term*` prefix wildcard,
 * compiled to a disjunction-of-conjunctions plan evaluated against a record's
 * lowercased searchable text. See the cycle-27 design doc for the grammar and
 * the deviations from the proposal's FTS5 syntax.
 *
 * Operators are UPPERCASE-ONLY (`OR`, `NOT`, `AND`); lowercase `or`/`not`/`and`
 * are ordinary terms, so every all-lowercase query stays a pure-AND substring
 * search (back-compat with cycle 19). The parser is total — it never throws.
 */

/** One compiled term. `value` is already lowercased (phrase: whitespace-normalized). */
export interface QueryTerm {
  kind: 'plain' | 'phrase' | 'prefix';
  value: string;
  negated: boolean;
}

/** A compiled query: ANY OR-group fully matching (AND within a group) = a hit. */
export interface QueryPlan {
  orGroups: QueryTerm[][];
  /**
   * The first non-negated term's literal (lowercased) for snippet centering, or
   * `''` when the query is all-negation / empty. `searchTranscripts` passes this
   * to `snippet(text, seed)`.
   */
  seed: string;
}

type Token = { type: 'word' | 'phrase'; text: string };

/**
 * Split a query into word/phrase tokens. A `"` opens a phrase that runs to the
 * next `"` or end-of-input (an unclosed quote → phrase-to-end, never an error);
 * otherwise a run of non-whitespace, non-`"` characters is a word.
 */
function tokenize(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
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
    // A word: run up to the next whitespace or quote.
    let j = i;
    while (j < q.length && !/\s/.test(q[j]) && q[j] !== '"') j++;
    tokens.push({ type: 'word', text: q.slice(i, j) });
    i = j;
  }
  return tokens;
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a query string into a {@link QueryPlan}. Total (never throws). Empty
 * OR-groups are dropped; an all-empty parse yields `orGroups: []`, which
 * `matchesQuery` treats as "matches nothing" (the caller returns no results).
 */
export function parseQuery(q: string): QueryPlan {
  const tokens = tokenize(q);
  const groups: QueryTerm[][] = [];
  let current: QueryTerm[] = [];
  let pendingNegate = false;

  const pushTerm = (
    kind: QueryTerm['kind'],
    value: string,
    negated: boolean,
  ): void => {
    if (!value) return;
    current.push({ kind, value, negated });
  };

  for (const tok of tokens) {
    if (tok.type === 'phrase') {
      const value = tok.text.replace(/\s+/g, ' ').trim().toLowerCase();
      pushTerm('phrase', value, pendingNegate);
      pendingNegate = false;
      continue;
    }

    const w = tok.text;
    if (w === 'OR') {
      if (current.length) groups.push(current);
      current = [];
      pendingNegate = false;
      continue;
    }
    if (w === 'AND') continue; // implicit AND — accept the keyword as a no-op.
    if (w === 'NOT' || w === '-') {
      pendingNegate = true;
      continue;
    }

    let negated = pendingNegate;
    pendingNegate = false;
    let text = w;
    if (text.startsWith('-')) {
      negated = true;
      text = text.slice(1);
    }
    if (text.endsWith('*')) {
      pushTerm('prefix', text.slice(0, -1).toLowerCase(), negated);
    } else {
      pushTerm('plain', text.toLowerCase(), negated);
    }
  }
  if (current.length) groups.push(current);

  let seed = '';
  outer: for (const g of groups) {
    for (const t of g) {
      if (!t.negated) {
        seed = t.value;
        break outer;
      }
    }
  }

  return { orGroups: groups, seed };
}

/** Does a single term match the (already lowercased) haystack? */
function termMatch(t: QueryTerm, hayLower: string): boolean {
  let hit: boolean;
  if (t.kind === 'prefix') {
    // Word-boundary prefix: a token starting with the stem. The stem is escaped
    // and followed by no quantifier → a linear, ReDoS-safe literal match.
    hit = new RegExp('\\b' + escapeRegExp(t.value)).test(hayLower);
  } else {
    // plain and phrase are both substring matches.
    hit = hayLower.includes(t.value);
  }
  return t.negated ? !hit : hit;
}

/**
 * Evaluate a compiled plan against a record's lowercased searchable text. A hit
 * requires ANY OR-group whose every term matches. An empty plan (no groups)
 * never matches.
 */
export function matchesQuery(plan: QueryPlan, hayLower: string): boolean {
  if (plan.orGroups.length === 0) return false;
  return plan.orGroups.some((group) =>
    group.every((t) => termMatch(t, hayLower)),
  );
}
