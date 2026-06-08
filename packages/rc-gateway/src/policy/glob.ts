/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-string glob match where `*` matches any run of characters (including
 * empty) and every other character is matched literally. `**` behaves the same
 * as `*` (the MVP makes no depth distinction).
 *
 * Implemented as a linear two-pointer scan with greedy backtracking on the LAST
 * star only — NOT a RegExp. A regex of the form `^.*a.*b.*$` exhibits
 * catastrophic backtracking (ReDoS) on adversarial input, and tool-call args
 * are model/session-influenced, so a benign operator glob like `*a*b*c*` plus a
 * hostile arg string could otherwise hang the event loop. This algorithm is
 * worst-case O(n·m) with no exponential blowup, and never compiles a pattern,
 * so a rule string also cannot inject regex.
 */
export function globMatch(glob: string, value: string): boolean {
  let g = 0;
  let v = 0;
  let star = -1; // index in `glob` of the last `*` seen
  let vStar = 0; // index in `value` where that `*` began matching
  while (v < value.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g;
      vStar = v;
      g++;
    } else if (g < glob.length && glob[g] === value[v]) {
      g++;
      v++;
    } else if (star !== -1) {
      // Backtrack: let the last `*` consume one more character.
      g = star + 1;
      vStar++;
      v = vStar;
    } else {
      return false;
    }
  }
  // Trailing stars in the glob match the empty remainder.
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/**
 * True if `value` matches any of `globs`. An undefined `globs` returns true: an
 * absent match field does not constrain (the evaluator's AND semantics).
 */
export function matchesAny(
  globs: string | string[] | undefined,
  value: string,
): boolean {
  if (globs === undefined) return true;
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some((g) => globMatch(g, value));
}
