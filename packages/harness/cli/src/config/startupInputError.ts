/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger, writeToStderr } from '@qwen-code/core';

/**
 * Typed error used to signal that a startup validation failure has already
 * been emitted to stderr and the CLI should exit with a non-zero code.
 */
export class StartupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupInputError';
  }
}

/**
 * Wraps a failure thrown by the root command's own execution
 * (handleRootCommand) so main()'s parse epilogue can tell it apart from an argv
 * parsing failure and rethrow the original error untouched. Without this marker
 * the generic parse-error epilogue would swallow FatalError exit codes.
 */
export class RootCommandExecutionError extends Error {
  constructor(readonly reason: unknown) {
    super('Root command execution failed');
    this.name = 'RootCommandExecutionError';
  }
}

/**
 * Emit a user-facing error during pre-init startup (argv parsing), before the
 * Config object / Ink TUI exist. `runLogger.error` alone is invisible this early
 * — its sink is unattached, so it only reaches the diagnostic log file. We keep
 * that diagnostic record and additionally write to the real stderr via the
 * sanctioned escape hatch so the user actually sees the error.
 */
export function emitStartupError(message: string): void {
  runLogger.error(message);
  writeToStderr(`${message}\n`);
}

/**
 * Reports a startup validation failure, then leaves via the bounded exit path.
 * Every argv validation branch shares this epilogue, so the exit policy
 * lives in one place instead of being restated per branch.
 */
export async function reportStartupInputError(message: string): Promise<never> {
  emitStartupError(message);
  throw new StartupInputError(message);
}
