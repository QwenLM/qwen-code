/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { braceExpand, unescape } from 'minimatch';

/** The longest Hosted glob pattern, matching the `path` argument's cap. */
export const HOSTED_GLOB_PATTERN_MAX_LENGTH = 1024;

/** glob searches every brace alternative, so their number is bounded. */
export const HOSTED_GLOB_MAX_ALTERNATIVES = 64;

// brace-expansion recurses once per nesting level and its output caps do not
// bound the depth, so a deeply nested pattern overflows the stack.
const MAX_BRACE_DEPTH = 8;

const SEQUENCE =
  /^(?:(-?\d+)\.\.(-?\d+)|([a-zA-Z])\.\.([a-zA-Z]))(?:\.\.(-?\d+))?$/;

export const HOSTED_GLOB_TOO_COMPLEX = `Hosted glob patterns are limited to ${HOSTED_GLOB_PATTERN_MAX_LENGTH} characters, balanced braces and ${HOSTED_GLOB_MAX_ALTERNATIVES} brace alternatives. Split the search into simpler patterns and retry.`;

export type HostedGlobPatternCheck = 'ok' | 'escapes' | 'too-complex';

/**
 * Classifies a model-supplied glob pattern before anything expands it.
 * brace-expansion's output cap exceeds the Hosted search budget, and glob
 * expands the same pattern again, so the size is bounded from the pattern's
 * structure first; only a pattern proven small is
 * expanded, and its alternatives must stay relative and free of `..`
 * segments. The walk itself is contained too (GlobTool's
 * `containmentRoot`); this check is the cheap, model-correctable fast path.
 */
export function checkHostedGlobPattern(
  pattern: string,
): HostedGlobPatternCheck {
  if (
    pattern.length > HOSTED_GLOB_PATTERN_MAX_LENGTH ||
    alternativesBound(pattern) > HOSTED_GLOB_MAX_ALTERNATIVES
  )
    return 'too-complex';
  // Segment equality, so a literal `a/..b/*.ts` stays usable.
  return braceExpand(pattern).some((alternative) => {
    const shape = unescape(alternative);
    return path.isAbsolute(shape) || shape.split(/[\\/]/).includes('..');
  })
    ? 'escapes'
    : 'ok';
}

/**
 * An upper bound on the alternatives brace-expansion yields for `text`,
 * without expanding it: a comma group sums its items, a `{x..y[..step]}`
 * sequence counts its span, adjacent groups multiply. Anything it cannot
 * bound (unbalanced braces, nesting inside a single-item group, excessive
 * nesting) is unbounded.
 */
function alternativesBound(text: string): number {
  let index = 0;
  const limit = HOSTED_GLOB_MAX_ALTERNATIVES + 1;

  // A run of literals and groups, up to an unmatched `,` or `}` at `depth`.
  const sequence = (depth: number): number => {
    let product = 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '{') {
        if (depth >= MAX_BRACE_DEPTH) return Infinity;
        index++;
        product = Math.min(product * group(depth + 1), limit);
      } else if ((char === ',' || char === '}') && depth > 0) {
        return product;
      } else if (char === '}') {
        // brace-expansion re-reads a literal group before a stray `}` as a
        // comma group (`{x},y}`), so an unmatched `}` cannot be bounded.
        return Infinity;
      } else {
        index++;
      }
    }
    return depth > 0 ? Infinity : product;
  };

  // The body of one `{...}`, consuming its closing brace.
  const group = (depth: number): number => {
    const start = index;
    const items: number[] = [sequence(depth)];
    while (text[index] === ',') {
      index++;
      items.push(sequence(depth));
    }
    if (text[index] !== '}') return Infinity;
    const body = text.slice(start, index);
    index++;
    if (items.length > 1)
      return Math.min(
        items.reduce((sum, item) => sum + item, 0),
        limit,
      );
    // A single-item group re-braces each inner alternative, which can
    // assemble a new sequence (`{1..{,9999}}`), so nesting inside one is
    // not bounded.
    if (items[0] > 1 || body.includes('{')) return Infinity;
    const range = SEQUENCE.exec(body);
    if (!range) return 1;
    if (
      [range[1], range[2], range[5]].some(
        (value) => value !== undefined && !Number.isSafeInteger(Number(value)),
      )
    )
      return Infinity;
    const step = Math.max(Math.abs(Number(range[5] ?? 1)), 1);
    const span =
      range[1] !== undefined
        ? Math.abs(Number(range[2]) - Number(range[1]))
        : Math.abs(range[4].charCodeAt(0) - range[3].charCodeAt(0));
    if (!Number.isSafeInteger(span)) return Infinity;
    return Math.min(Math.floor(span / step) + 1, limit);
  };

  return sequence(0);
}
