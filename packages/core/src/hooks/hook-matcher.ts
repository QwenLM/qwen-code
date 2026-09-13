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
 * Splits a matcher at the pipes that separate list entries. A pipe escaped by
 * a backslash, or inside `[...]` or a group, is part of the regular expression,
 * so it does not split and the spaces around it stay. Backslashes are read in
 * pairs: in `C:\\temp\\|D:\\data` the pipe follows an escaped backslash, so it
 * does separate entries.
 */
function splitListEntries(pattern: string): string[] {
  const entries: string[] = [];
  let current = '';
  let escaped = false;
  let inCharacterClass = false;
  let groupDepth = 0;
  for (const char of pattern) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (inCharacterClass) {
      inCharacterClass = char !== ']';
    } else if (char === '[') {
      inCharacterClass = true;
    } else if (char === '(') {
      groupDepth++;
    } else if (char === ')') {
      groupDepth = Math.max(0, groupDepth - 1);
    } else if (char === '|' && groupDepth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries;
}

/**
 * Tests a hook `matcher` against the value an event is matched on, using the
 * same rules for every event and for both settings and session hooks:
 *
 * - An empty matcher, `*` or `.*` matches everything.
 * - The matcher matches the subject or an alias exactly.
 * - Unless the whole matcher starts with `^` or `(`, a `|`-separated list
 *   matches when any entry, with surrounding spaces removed, is `*`, `.*`, or
 *   exactly the subject or an alias. Only a `|` outside `[...]` and groups
 *   and not escaped by a backslash separates entries: the pipes in
 *   `notes\|todo\.md`, `foo[ |]bar` and `a(b | c)` belong to the expression,
 *   spaces around them included. Entries are never compiled on their own.
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
    // Split only where a pipe separates list entries, and compare and rebuild
    // from the same trimmed entries, so `read_.* | edit` reads as
    // `read_.*|edit` while `foo[ |]bar` keeps its space.
    const alternatives = splitListEntries(pattern)
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
    // Only empty entries are dropped; a pipe inside a group or class was never
    // split, so `a(b|c)|` rebuilds as `a(b|c)`.
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
