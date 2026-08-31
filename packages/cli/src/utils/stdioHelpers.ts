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
 * `writeStdoutLine` that cannot terminate the process — the stdout twin of
 * `writeStderrLineBestEffort`.
 *
 * A try/catch alone is not enough: when stdout is redirected to a failing
 * target (a dead pipe after `qwen … | head`, a full daemon-log disk), Node
 * emits an ASYNCHRONOUS `'error'` event on `process.stdout` that terminates
 * the process past any surrounding try/catch. Best-effort diagnostics — the
 * persistence-loss warnings that fire exactly when the disk is failing, the
 * skip notices on a dead reader — must not defeat the never-fails design
 * they belong to, so install a no-op `'error'` guard while nothing else
 * listens, then write through the sync-safe helper (#8975). Primary command
 * output stays on the loud `writeStdoutLine`.
 */
export const writeStdoutLineBestEffort = (message: string): void => {
  if (process.stdout.listenerCount('error') === 0) {
    process.stdout.on('error', () => {
      // The stdout target is gone; this diagnostic is already lost.
    });
  }
  writeStdoutLineSafe(message);
};

/**
 * `writeStderrLine` that cannot terminate the process — the stderr
 * analogue of `writeStdoutLineBestEffort`.
 *
 * A try/catch alone is not enough: when stderr is redirected to a failing
 * target (a full daemon-log disk — the same disk condition that fails the
 * state writes these diagnostics accompany — or a dead redirect), Node
 * emits an ASYNCHRONOUS `'error'` event on `process.stderr` that
 * terminates the process past any surrounding try/catch. A warning fired
 * from a long-lived supervisor path on every launch (a reserved channel
 * name left in settings) becomes a crash loop bounded only by the restart
 * budget, so guard the async channel while nothing else listens, then
 * write through the sync-safe helper (#8975). Primary error output stays
 * on the loud `writeStderrLine`.
 */
export const writeStderrLineBestEffort = (message: string): void => {
  if (process.stderr.listenerCount('error') === 0) {
    process.stderr.on('error', () => {
      // The stderr target is gone; this diagnostic is already lost.
    });
  }
  writeStderrLineSafe(message);
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
