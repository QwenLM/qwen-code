/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A word bash hands a command exactly as written. None of these characters
 * quotes, escapes, expands, globs, redirects, comments or separates in bash,
 * so any splitter reads the same words from text made of them.
 */
const PLAIN_WORD = /^[A-Za-z0-9._/:@%+=,-]+$/;

/** git stops reading options at either of these. */
const OPTION_TERMINATORS = new Set(['--', '--end-of-options']);

/**
 * Whether `git remote show` in `commandText` is proven to get `-n`, which
 * keeps it from querying the remote (#14359).
 *
 * The proof reads the command's raw text, not a parser's words. A parser
 * that builds words differently from bash can produce a `-n` bash never
 * passes: tree-sitter drops the backslash of an escaped blank and ends a
 * word at `\r`, and a here-string or heredoc puts a `-n` where an argument
 * would be. So only text made of plain words separated by spaces or tabs is
 * read, where any splitter agrees with bash; anything else is not proof,
 * and the command is asked about. A `-n` after `--` or `--end-of-options` is
 * a positional, not the flag.
 */
export function isOfflineRemoteShow(commandText: string): boolean {
  // Split, then test each word: an end-anchored trim of blanks takes
  // quadratic time on a long run of them.
  const words = commandText.split(/[ \t]+/).filter((word) => word !== '');
  if (!words.every((word) => PLAIN_WORD.test(word))) return false;
  const remote = words.indexOf('remote');
  const show = remote < 0 ? -1 : words.indexOf('show', remote + 1);
  if (show < 0) return false;
  const args = words.slice(show + 1);
  const end = args.findIndex((word) => OPTION_TERMINATORS.has(word));
  return (end < 0 ? args : args.slice(0, end)).includes('-n');
}
