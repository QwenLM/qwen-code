/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compile a glob string to an anchored, full-match RegExp. All regex
 * metacharacters in the glob are escaped FIRST so a rule string can never
 * inject regex; then `*` is turned into `.*` (a single `*` and `**` both
 * collapse to `.*` for the MVP). The pattern is anchored `^…$`.
 */
export function globToRegExp(glob: string): RegExp {
  // Escape every regex metacharacter. `*` is included here (becomes `\*`) and
  // is then rewritten to `.*` below — escaping first prevents injection.
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\\\*/g, '.*');
  return new RegExp(`^${body}$`);
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
  return list.some((g) => globToRegExp(g).test(value));
}
