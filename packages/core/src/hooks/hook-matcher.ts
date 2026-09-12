/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_MATCHER');

export interface HookPatternOptions {
  /**
   * Other exact names the subject is known by, such as tool display names and
   * legacy aliases. They only match exactly, never through a regex, so an
   * alias cannot widen what a regex matches.
   */
  aliases?: readonly string[];
}

/**
 * Tests a hook `matcher` against the value an event is matched on, using the
 * same rules for every event and for both settings and session hooks:
 *
 * - An empty matcher, `*` or `.*` matches everything.
 * - The matcher matches the subject or an alias exactly.
 * - Unless the whole matcher starts with `^` or `(`, a `|`-separated list
 *   matches when any entry, with surrounding spaces removed, is `*`, `.*`, or
 *   exactly the subject or an alias. Only an unescaped `|` separates entries:
 *   a `|` preceded by a backslash, as in `notes\|todo\.md`, stays part of its
 *   entry. Entries are never compiled on their own.
 * - Otherwise the matcher is an unanchored regular expression tested against
 *   the subject only; aliases are never matched through a regex. For a list
 *   that does not start with `^` or `(`, the expression is rebuilt from the
 *   trimmed, non-empty entries, so a stray `|` never turns it into a
 *   match-all and a matcher made only of `|` matches nothing. A matcher that
 *   starts with `^` or `(` is compiled as written, so a trailing `|` there
 *   does match everything. An invalid expression matches nothing further.
 */
export function matchesHookPattern(
  matcher: string,
  subject: string,
  options: HookPatternOptions = {},
): boolean {
  const pattern = matcher.trim();
  if (pattern === '' || pattern === '*' || pattern === '.*') {
    return true;
  }

  const exactTargets = [subject, ...(options.aliases ?? [])];
  if (exactTargets.includes(pattern)) {
    return true;
  }

  let expression = pattern;
  if (
    pattern.includes('|') &&
    !pattern.startsWith('^') &&
    !pattern.startsWith('(')
  ) {
    // Split only on unescaped pipes, and compare and rebuild from the same
    // trimmed entries, so `read_.* | edit` reads as `read_.*|edit`.
    const alternatives = pattern
      .split(/(?<!\\)\|/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (
      alternatives.some(
        (entry) =>
          entry === '*' || entry === '.*' || exactTargets.includes(entry),
      )
    ) {
      return true;
    }
    if (alternatives.length === 0) {
      return false;
    }
    // A group that spans the pipe, such as `a(b|c)`, still reads as one
    // expression once the empty alternatives are gone.
    expression = alternatives.join('|');
  }

  try {
    return new RegExp(expression).test(subject);
  } catch (error) {
    debugLogger.warn(
      `Invalid regex in hook matcher "${pattern}" for "${subject}": ${error}`,
    );
    return false;
  }
}
