/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility functions for writing to stdout/stderr in CLI commands.
 *
 * These helpers are used instead of console.log/console.error in standalone
 * CLI commands (like `qwen extensions list`) where the output IS the user-facing
 * result, not debug logging.
 *
 * For debug/diagnostic logging, use `createDebugLogger()` from @qwen-code/qwen-code-core.
 */

/**
 * Writes a message to stdout with a trailing newline.
 * Use for normal command output that the user expects to see.
 * Avoids double newlines if the message already ends with one.
 */
export const writeStdoutLine = (message: string): void => {
  process.stdout.write(message.endsWith('\n') ? message : `${message}\n`);
};

/**
 * Writes a message to stderr with a trailing newline.
 * Use for error messages in CLI commands.
 * Avoids double newlines if the message already ends with one.
 */
export const writeStderrLine = (message: string): void => {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
};

/**
 * Clears the terminal screen.
 * Use instead of console.clear() to satisfy no-console lint rules.
 */
export const clearScreen = (): void => {
  console.clear();
};
