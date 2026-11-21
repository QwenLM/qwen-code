/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one delimiter grammar shared by every layer that defangs a tagged
 * envelope embedded in teammate-authored text.
 *
 * A delimiter is `<`, then a run of `/` and whitespace in ANY order and length,
 * then the tag name. The consumers of these envelopes do not normalise the
 * spelling — `TeamManager`'s `escapeEnvelopeTags`, the recovery trim in
 * `turn-interruption.ts`, and the ACP peer envelope all have to treat
 * `</x>`, `< / x>`, `<//x>` and `<        /x>` as the same closing delimiter,
 * because each one closes (or opens) the envelope for a parser that only looks
 * for the tag name. Escaping a subset of those spellings leaves the rest raw,
 * which is the breakout every caller here exists to prevent. So the grammar
 * lives in one place: adding a tag name is the only per-layer decision left.
 *
 * Only the opening `<` is escaped to `&lt;`; the body is never XML-escaped
 * wholesale. The TUI, stream-json and task-list paths deliver this identical
 * string verbatim, so entity-encoding it would corrupt genuine markup and every
 * comparison inside a report.
 *
 * Two details are load-bearing:
 *
 * - `(?=[\s>/]|$)` keeps a longer tag that merely shares the prefix
 *   (`<task-notification-extra>`, `<teammate_messages>`) out of the match.
 * - `/` and whitespace share ONE character class rather than two adjacent
 *   unbounded repeats. Two repeats re-scan the same run for every backtracking
 *   start, which is quadratic in the body length: a 64 KiB run of spaces after
 *   `<` stalls the host event loop for seconds.
 */

const patterns = new Map<string, RegExp>();

/**
 * Neutralises every copy of `tags` used as an envelope delimiter in `text`.
 * Tag names are literal (they are module constants, never user input).
 */
export function defangEnvelopeDelimiters(
  text: string,
  tags: readonly string[],
): string {
  if (tags.length === 0 || text.length === 0) return text;
  const key = tags.join('\u0000');
  let pattern = patterns.get(key);
  if (!pattern) {
    // `String.prototype.replace` resets the `/g` flag's `lastIndex`, so one
    // compiled pattern is safe to share across calls.
    pattern = new RegExp(
      `<(?=[\\s/]*(?:${tags.join('|')})(?=[\\s>/]|$))`,
      'gi',
    );
    patterns.set(key, pattern);
  }
  return text.replace(pattern, '&lt;');
}
