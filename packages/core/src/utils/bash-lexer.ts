/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bash's lexer skips exactly space, tab and newline when it decides word
 * boundaries (`whitespace(c)` in bash's `parse.y`). These coincide with bash's
 * default `IFS`, but `IFS` is not what matters here: operator adjacency is
 * decided by the lexer, so this set must not be widened to follow a custom
 * `IFS`.
 *
 * JavaScript's `\s` is wider: it also matches `\r`, `\v`, `\f`, `\u00a0` and
 * the rest of Unicode whitespace, every one of which bash treats as an ordinary
 * word character. Using `\s` as if it were bash's separator joined
 * `echo x >\r& rm -rf /`-style payloads into a single segment whose leading
 * allow rule then covered the trailing command (#11851, #12089).
 */
const BASH_WORD_SEPARATORS = [' ', '\t', '\n'];

/**
 * Whether `ch` is a character bash's lexer discards as a word separator.
 *
 * Kept in a leaf module on purpose: both the permission rule parser
 * (`permissions/rule-parser.ts`) and the shell splitter (`utils/shell-utils.ts`)
 * need this predicate, and having the parser import `shell-utils.ts` at runtime
 * would drag the tool and config graph into the parser.
 */
export function isBashWordSeparator(ch: string | undefined): boolean {
  return ch !== undefined && BASH_WORD_SEPARATORS.includes(ch);
}
