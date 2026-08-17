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
 * Wait until any pending stdout/stderr writes have flushed.
 *
 * On POSIX pipes `process.stdout.write` flushes asynchronously, so a
 * `process.exit()` right after writing silently discards buffered output
 * (beyond the ~80KB pipe buffer). Call this before a deliberate early exit
 * that follows user-facing writes (e.g. `qwen agents` subcommands, `--bg`).
 *
 * A pipe consumer that exits early (`qwen agents logs <id> | head`) turns
 * the queued writes into EPIPE errors, and one that holds the pipe open
 * without reading would block the drain forever — so errors settle the
 * drain immediately and a timeout caps the wait.
 */
export const drainStdioBeforeExit = (timeoutMs = 5000): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const onError = (): void => settle();
    process.stdout.once('error', onError);
    process.stderr.once('error', onError);
    const timer = setTimeout(settle, timeoutMs);
    timer.unref?.();
    process.stdout.write('', () => {
      process.stderr.write('', () => {
        clearTimeout(timer);
        process.stdout.removeListener('error', onError);
        process.stderr.removeListener('error', onError);
        settle();
      });
    });
  });

/**
 * Clears the terminal screen.
 * Use instead of console.clear() to satisfy no-console lint rules.
 */
export const clearScreen = (): void => {
  console.clear();
};
