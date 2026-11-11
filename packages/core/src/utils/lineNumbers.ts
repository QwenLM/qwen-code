/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Line number formatting utilities for file content display.
 * Adds cat -n style line numbers using compact tab format (default).
 */

/**
 * Adds cat -n style line numbers to the content.
 *
 * Default format (compact): `N\tline` — minimal overhead.
 *
 * @example
 *   addLineNumbers({ content: "foo\nbar", startLine: 1 })
 *   // "1\tfoo\n2\tbar"
 */
export function addLineNumbers({
  content,
  startLine,
}: {
  content: string;
  /** 1-indexed starting line number. */
  startLine: number;
}): string {
  if (!content) {
    return '';
  }

  const lines = content.split(/\r?\n/);
  return lines.map((line, index) => `${index + startLine}\t${line}`).join('\n');
}

/**
 * Inverse of addLineNumbers -- strips the `N\t` prefix from a single
 * line. Co-located so format changes stay in sync with addLineNumbers.
 */
export function stripLineNumberPrefix(line: string): string {
  const match = line.match(/^\s*\d+[\u2192\t](.*)$/);
  return match?.[1] ?? line;
}
