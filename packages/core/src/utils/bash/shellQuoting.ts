/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command quoting utilities for safe shell execution.
 * Handles heredocs, multiline strings, stdin redirection, and Windows null redirect rewriting.
 */

import { quote } from 'shell-quote';

/**
 * Detects heredoc syntax in a command string.
 * Matches <<EOF, <<'EOF', <<"EOF", <<-EOF, <<\EOF patterns.
 * Excludes bit-shift operators (e.g., `1 << 2`).
 */
// Pre-compiled regex patterns for heredoc detection
const HEREDOC_PATTERN = /<<[-~]?\s*\\?['"]?\w+['"]?/;
const BIT_SHIFT_PATTERN = /\d\s*<<\s*\d/;
const ARITHMETIC_PATTERN = /\$\(\(/;

function containsHeredoc(command: string): boolean {
  const heredocPattern = HEREDOC_PATTERN;
  const bitShiftPattern = BIT_SHIFT_PATTERN;
  const arithmeticPattern = ARITHMETIC_PATTERN;

  if (!heredocPattern.test(command)) {
    return false;
  }

  // If it looks like arithmetic or bit-shift, it's not a heredoc
  if (bitShiftPattern.test(command) || arithmeticPattern.test(command)) {
    // Could still have heredocs alongside arithmetic, but conservatively treat as heredoc
    // to avoid breaking valid heredoc commands
    return true;
  }

  return true;
}

/**
 * Detects actual newlines inside quoted strings (single or double).
 */
// Pre-compiled regex patterns for multiline string detection
const SINGLE_QUOTE_MULTILINE = /'[^']*\n[^']*'/s;
const DOUBLE_QUOTE_MULTILINE = /"[^"]*\n[^"]*"/s;

function containsMultilineString(command: string): boolean {
  return (
    SINGLE_QUOTE_MULTILINE.test(command) || DOUBLE_QUOTE_MULTILINE.test(command)
  );
}

/**
 * Single-quote a string for use inside `eval`.
 * Escapes existing single quotes using the `'"'"'` technique.
 */
export function singleQuoteForEval(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Quotes a shell command for safe execution via `eval`.
 *
 * Three paths:
 * 1. Heredoc commands: Manual single-quote escaping, no stdin redirect.
 * 2. Multiline string commands: Manual single-quote escaping, with optional stdin redirect.
 * 3. Regular commands: Uses shell-quote library, with optional stdin redirect.
 *
 * @param command - The raw command string.
 * @param addStdinRedirect - Whether to append `< /dev/null` for stdin safety.
 */
export function quoteShellCommand(
  command: string,
  addStdinRedirect: boolean = true,
): string {
  if (containsHeredoc(command)) {
    // Heredocs cannot have stdin redirected (they ARE stdin)
    return singleQuoteForEval(command);
  }

  if (containsMultilineString(command)) {
    // Multiline strings need manual quoting to preserve newlines
    const quoted = singleQuoteForEval(command);
    if (addStdinRedirect) {
      return quoted + ' < /dev/null';
    }
    return quoted;
  }

  // Regular command: use shell-quote for proper escaping
  const args = addStdinRedirect
    ? [command, { op: '<' }, '/dev/null']
    : [command];
  return quote(args as Parameters<typeof quote>[0]);
}

/**
 * Checks if a command already has stdin redirection (e.g., `< file`, `< /dev/null`).
 * Does not match heredocs (`<<`) or process substitution (`<(`).
 */
export function hasStdinRedirect(command: string): boolean {
  return /(?:^|[\s;&|])<(?![<(])\s*\S+/.test(command);
}

/**
 * Determines whether `< /dev/null` should be added to a command.
 * Returns false if the command uses heredocs or already has stdin redirection.
 */
export function shouldAddStdinRedirect(command: string): boolean {
  if (containsHeredoc(command)) {
    return false;
  }
  if (hasStdinRedirect(command)) {
    return false;
  }
  return true;
}

/**
 * Rewrites Windows-style null redirects (`>nul`, `2>nul`, `&>nul`, `>>nul`)
 * to Unix equivalents (`>/dev/null`, etc.).
 */
export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(
    /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g,
    '$1/dev/null',
  );
}
