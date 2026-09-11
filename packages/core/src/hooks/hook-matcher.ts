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
 * - Unless the whole matcher starts with `^` or `(`, a `|`-separated list is
 *   decided entry by entry with these same rules. Empty entries are ignored
 *   and never widen the list into a match-all expression.
 * - Otherwise the matcher is an unanchored regular expression tested against
 *   the subject only; aliases are never matched through a regex. An invalid
 *   expression matches nothing further.
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
  if (
    pattern.includes('|') &&
    !pattern.startsWith('^') &&
    !pattern.startsWith('(')
  ) {
    const alternatives = pattern.split('|').map((entry) => entry.trim());
    const entries = alternatives.filter((entry) => entry !== '');
    if (entries.some((entry) => matchesHookPattern(entry, subject, options))) {
      return true;
    }
    if (entries.length !== alternatives.length) {
      // A stray `|` must not turn the list into a match-all expression.
      return false;
    }
    // Fall through for a group that spans the pipe, such as `a(b|c)`.
  }

  try {
    return new RegExp(pattern).test(subject);
  } catch (error) {
    debugLogger.warn(
      `Invalid regex in hook matcher "${pattern}" for "${subject}": ${error}`,
    );
    return false;
  }
}
