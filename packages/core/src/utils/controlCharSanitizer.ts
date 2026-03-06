/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sanitizes terminal output by handling control characters that can cause
 * rendering issues in Ink-based UIs.
 *
 * This handles carriage returns and other control characters that can cause
 * display issues, inspired by Claude Code's approach to terminal output handling.
 *
 * @param output - Raw terminal output string
 * @returns Sanitized output safe for Ink rendering
 */
export function sanitizeTerminalOutput(output: string): string {
  if (!output) {
    return output;
  }

  let sanitized = output;

  // Step 1: Normalize Windows-style line endings (\r\n) to Unix-style (\n)
  sanitized = sanitized.replace(/\r\n/g, '\n');

  // Step 2: Handle standalone \r (carriage return without newline)
  // A standalone \r moves cursor to beginning of line without advancing
  // We convert it to \n to preserve line structure
  sanitized = sanitized.replace(/\r(?!\n)/g, '\n');

  // Step 3: Remove other problematic control characters
  // Keep \t (tab) and \n (newline) as they're safe for Ink
  // Remove: \x00-\x08 (NULL-BS), \x0B (\v), \x0C (\f), \x0E-\x1F (SO-US)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  return sanitized;
}

/**
 * Sanitizes an AnsiOutput object's text tokens.
 *
 * @param ansiOutput - Raw AnsiOutput from terminal serializer
 * @returns Sanitized AnsiOutput safe for Ink rendering
 */
export function sanitizeAnsiOutput(
  ansiOutput: import('./terminalSerializer').AnsiOutput,
): import('./terminalSerializer').AnsiOutput {
  if (!ansiOutput) {
    return ansiOutput;
  }

  return ansiOutput.map((line) =>
    line.map((token) => ({
      ...token,
      text: sanitizeTerminalOutput(token.text),
    })),
  );
}
