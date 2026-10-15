/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';

/**
 * Utility functions for writing to stdout/stderr in CLI commands.
 *
 * These helpers are used instead of console.log/console.error in standalone
 * CLI commands (like `qwen extensions list`) where the output IS the user-facing
 * result, not debug logging.
 *
 * For debug/diagnostic logging, use `createDebugLogger()` from @qwen-code/qwen-code-core.
 */

// Control characters are intentionally stripped from daemon log lines.
/* eslint-disable no-control-regex */
export const LOG_LINE_UNSAFE_RE =
  /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

/**
 * Renders Store- or cause-derived free text safe for a single-line daemon
 * stderr/log sink: terminal escape sequences and C0/C1 controls are removed
 * first (`stripAnsiAndControl` removes them outright), then the
 * log-line-unsafe class — `\r`, U+2028/U+2029, bidi overrides and invisible
 * formatters — becomes a space, capped at 4096. The order is load-bearing:
 * the second step substitutes a space per character, so an escape sequence
 * reaching it would leave its `[2J` tail behind.
 */
export function sanitizeDaemonLogLine(text: string): string {
  return stripAnsiAndControl(text)
    .replace(LOG_LINE_UNSAFE_RE, ' ')
    .slice(0, 4096);
}

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
 * `writeStdoutLine` that cannot throw.
 *
 * Same contract as `writeStderrLineSafe`: use it where the write is
 * incidental to the work in hand — an informational block whose reader
 * going away (`qwen … | head`) must not fail the command.
 */
export const writeStdoutLineSafe = (message: string): void => {
  try {
    writeStdoutLine(message);
  } catch {
    // stdout is gone. Whatever this line had to say, its reader left.
  }
};

/**
 * `writeStderrLine` that cannot throw.
 *
 * `process.stderr.write` throws on EPIPE or a closed fd — reachable whenever
 * the reader goes away (`qwen … | head`) or a daemon redirects its stderr. Most
 * of the CLI *wants* that to be loud, so this is not the default.
 *
 * Use it only where the write is incidental to the work in hand and failing it
 * would destroy something real: a diagnostic emitted mid-way through replaying
 * a transcript, say, where a throw would abandon the remaining records.
 */
export const writeStderrLineSafe = (message: string): void => {
  try {
    writeStderrLine(message);
  } catch {
    // stderr is gone. There is, definitionally, nowhere to report that.
  }
};

/**
 * Clears the terminal screen.
 * Use instead of console.clear() to satisfy no-console lint rules.
 */
export const clearScreen = (): void => {
  console.clear();
};

/**
 * Ignore a broken output pipe (`qwen … | head`, a daemon's closed redirect)
 * for the rest of this process.
 *
 * EPIPE arrives two ways when the reader goes away: a synchronous throw out
 * of the write (the `…Safe` writers above catch that) and an asynchronous
 * `'error'` event on the stream, which crashes the process as an unhandled
 * error unless a listener is present. This destroys the stream on the async
 * path — the convention `cost-ledger` and `nonInteractiveCli` use. Call it
 * once at the top of a command handler whose stdout IS its result, so a
 * reader that leaves cannot crash the process AFTER the work is done (for a
 * command that has already mutated state, that turns a completed action into
 * a crash-class exit). Idempotent listeners are fine — a CLI handler runs
 * once and the process then exits, so nothing detaches them.
 */
export const ignoreBrokenPipe = (): void => {
  process.stdout.on('error', (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.stdout.destroy();
  });
  process.stderr.on('error', (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.stderr.destroy();
  });
};
