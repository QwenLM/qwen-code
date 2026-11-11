/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// UI helpers only. Submitted references are handled by core attachments.

/**
 * Escapes unescaped @ symbols so they are not interpreted as @path commands.
 */
export function escapeAtSymbols(text: string): string {
  return text.replace(/(?<!\\)@/g, '\\@');
}

/**
 * Highlighting pattern for the path/command part of an @ reference.
 * It uses strict ASCII whitespace delimiters to allow Unicode characters like NNBSP in filenames.
 *
 * 1. "(?:[^"]*)" matches a double-quoted string (for Windows paths with spaces).
 * 2. \\. matches any escaped character (e.g., \ ).
 * 3. [^ \t\n\r,;!?()\[\]{}.] matches any character that is NOT a delimiter and NOT a period.
 * 4. \.(?!$|[ \t\n\r]) matches a period ONLY if it is NOT followed by whitespace or end-of-string.
 */
export const AT_MENTION_HIGHLIGHT_REGEX_SOURCE =
  '(?:(?:"(?:[^"]*)")|(?:\\\\.|[^ \\t\\n\\r,;!?()\\[\\]{}.]|\\.(?!$|[ \\t\\n\\r])))+';
